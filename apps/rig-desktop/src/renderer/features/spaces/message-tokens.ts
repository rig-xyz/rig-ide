import { FILE_TAG_SOURCE, tagPathOf } from '@shared/rig/file-tags';
import { trimUrl, URL_PATTERN } from '@shared/spaces/links';
import type { MessageMention, RoomMember } from './types';

/**
 * The Room's own bits inside a person's message, picked out of the
 * markdown's ordinary text: links, @mentions, a /command at the very start,
 * `+file` tags, `reviews/*.md`, absolute paths and `rig-file://` links. Code (inline or fenced)
 * and link text are never looked into, so `npm i -g @openai/codex` in
 * backticks stays code and never reads as a mention.
 *
 * Each token becomes a `roomToken` node that turns into
 * `<span data-room-token="kind" data-value="…">` for the renderer to draw
 * (`transcript-items.tsx`). Also, for chat: a single newline breaks the line
 * (as remark-breaks does), indented code is off (four leading spaces are
 * just text), an image is a link to it, and a bare URL or email is left for
 * the Room's own link rules rather than GFM's.
 */

type MdNode = {
  type: string;
  value?: string;
  url?: string;
  alt?: string | null;
  title?: string | null;
  children?: MdNode[];
  position?: { start: { offset?: number } };
  data?: Record<string, unknown>;
};

export type RoomTokenKind = 'link' | 'mention' | 'command' | 'file-tag' | 'review' | 'path';

type Named = Pick<RoomMember, 'id' | 'name'>;

/** Members by their first name alone, for the names only one member has. */
function uniqueFirstNames(members: readonly Named[]): Named[] {
  const byFirst = new Map<string, Named[]>();
  for (const member of members) {
    const first = member.name.trim().split(/\s+/)[0] ?? '';
    if (!first || first === member.name.trim()) continue;
    const key = first.toLowerCase();
    byFirst.set(key, [...(byFirst.get(key) ?? []), { id: member.id, name: first }]);
  }
  const taken = new Set(members.map((m) => m.name.trim().toLowerCase()));
  return [...byFirst.entries()]
    .filter(([key, named]) => new Set(named.map((n) => n.id)).size === 1 && !taken.has(key))
    .map(([, named]) => named[0]!);
}

/** The longest of `people`'s names written right after the "@" (ending at a word boundary), with whose it is. */
function longestName(rest: string, people: readonly Named[]): { token: string; memberId: string } | null {
  let best: { token: string; memberId: string } | null = null;
  for (const person of people) {
    const name = person.name.trim();
    if (!name || (best && name.length <= best.token.length - 1)) continue;
    const candidate = rest.slice(0, name.length);
    if (
      candidate.toLowerCase() !== name.toLowerCase() ||
      /[\p{L}\p{N}_]/u.test(rest.charAt(name.length))
    )
      continue;
    best = { token: `@${candidate}`, memberId: person.id };
  }
  return best;
}

/**
 * The @mention whose "@" is at `at`, if any. The people the message says it
 * tagged (`mentions`: id and the name as written) come first, under the name
 * written or their name now, so two members with the same name each get
 * their own and a renamed person still resolves. Then a member's display
 * name, longest first, so "@Hugo Renaudin" beats a member called "Hugo" and
 * never swallows the word after it; the name must end at a word boundary
 * ("@Hugonaut" isn't "@Hugo"). Then a member's first name alone, when no
 * other member shares it, the same rule the relay uses to notify. Then one of
 * the space's agents by kind (`@claude`), as the relay routes it. Anything
 * else, "@rigxyz/cli" or "@someone" who isn't here, stays plain text, so
 * what lights up is exactly who hears about it.
 */
export function mentionAt(
  text: string,
  at: number,
  members: readonly Named[],
  mentions: readonly MessageMention[] = [],
  /** The space's agent kinds (`claude`, `codex`): what an `@handle` can name besides people. */
  agents: readonly string[] = []
): { token: string; memberId?: string } | null {
  const rest = text.slice(at + 1);
  if (mentions.length > 0) {
    const tagged: Named[] = mentions.flatMap((m) => {
      const now = members.find((member) => member.id === m.id)?.name;
      return now && now !== m.name ? [m, { id: m.id, name: now }] : [m];
    });
    const hit = longestName(rest, tagged);
    if (hit) return hit;
  }
  const best = longestName(rest, members);
  if (best) return best;
  const first = longestName(rest, uniqueFirstNames(members));
  if (first) return first;
  const handle = /^[a-z][\w-]*/i.exec(rest)?.[0];
  if (!handle || /[/.@]/.test(rest.charAt(handle.length))) return null;
  return agents.some((agent) => agent.toLowerCase() === handle.toLowerCase()) ? { token: `@${handle}` } : null;
}

/**
 * Links first, so nothing inside a URL reads as a mention or a file. @ only
 * starts a mention after whitespace, the start, or opening punctuation (an
 * email's "@gmail" stays plain), and a /command only at the very start of
 * the message (a path like "/etc/hosts" stays plain). The mention group is
 * just the "@"; `mentionAt` decides how far it runs.
 */
function tokenPattern(atStart: boolean): RegExp {
  const command = atStart ? String.raw`^\/[a-z-]+(?![\w/.])` : '(?!)';
  return new RegExp(
    `(${URL_PATTERN.source})|((?<![\\w.@/:-])@)|(${command})|(${FILE_TAG_SOURCE})|(reviews\\/[\\w.-]+\\.md)|(?<abspath>(?<![\\w/.:~-])(?:file:\\/\\/)?\\/(?:Users|home|Volumes)\\/[^\\s'"\x60<>()\\[\\]{}|]+)|(?<rigfile>rig-file:\\/\\/[^\\s<>"'\x60]+)`,
    'g'
  );
}

function token(kind: RoomTokenKind, value: string, text: string, memberId?: string): MdNode {
  const hProperties: Record<string, string> = { dataRoomToken: kind, dataValue: value };
  if (memberId) hProperties.dataMember = memberId;
  return {
    type: 'roomToken',
    data: { hName: 'span', hProperties, hChildren: [{ type: 'text', value: text }] },
  };
}

/** Plain text, with each newline a line break. */
function pushText(out: MdNode[], value: string): void {
  value.split('\n').forEach((line, i) => {
    if (i > 0) out.push({ type: 'break' });
    if (line) out.push({ type: 'text', value: line });
  });
}

/** One run of ordinary text, split into text, line breaks and tokens. */
export function splitTokens(
  text: string,
  atStart: boolean,
  members: readonly Named[],
  /**
   * The message's tagged people: `all` of them, and those not matched yet
   * (`pending`, used up in order by the "@"s they match, so two tags of the
   * same name go to two people).
   */
  tags: { all: readonly MessageMention[]; pending: MessageMention[] } = { all: [], pending: [] },
  agents: readonly string[] = []
): MdNode[] {
  const pattern = tokenPattern(atStart);
  const out: MdNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const mention = match[2] ? mentionAt(text, match.index, members, [...tags.pending, ...tags.all], agents) : null;
    const used = mention?.memberId ? tags.pending.findIndex((m) => m.id === mention.memberId) : -1;
    if (used !== -1) tags.pending.splice(used, 1);
    // A file tag (`+path` or `+"path"`, see `shared/rig/file-tags.ts`); one that would leave the space stays text.
    const tagged = match[4] ? tagPathOf(match, 5, 6) : null;
    if ((match[2] && !mention) || (match[4] && !tagged)) {
      // A lone "@" (or "@Someone" who isn't here): stays in the surrounding text.
      pattern.lastIndex = match.index + 1;
      continue;
    }
    if (match.index > lastIndex) pushText(out, text.slice(lastIndex, match.index));
    let raw = match[0];
    if (match.groups?.rigfile) {
      // A link to a space's file as a page: opened like a path, the sentence's punctuation left as text.
      raw = trimUrl(raw);
      out.push(token('path', raw, raw));
    } else if (match.groups?.abspath) {
      // The sentence's own punctuation after a path stays text.
      raw = match.groups.abspath.replace(/[.,;:!?]+$/, '');
      out.push(token('path', raw, raw));
    } else if (match[1]) {
      // The sentence's own punctuation after a link stays text.
      raw = trimUrl(raw);
      out.push(token('link', raw, raw));
    } else if (mention) {
      raw = mention.token;
      out.push(token('mention', raw, raw, mention.memberId));
    } else if (tagged) {
      out.push(token('file-tag', tagged, raw));
    } else if (match[3]) {
      out.push(token('command', raw, raw));
    } else {
      out.push(token('review', raw, raw));
    }
    lastIndex = match.index + raw.length;
    pattern.lastIndex = lastIndex;
  }
  if (lastIndex < text.length) pushText(out, text.slice(lastIndex));
  return out;
}

function plainText(node: MdNode): string {
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(plainText).join('');
}

/** A link GFM made from a bare URL, `www.` address or email (or a `<url>` autolink): its text is the address. */
function isAutolink(node: MdNode): boolean {
  if (node.type !== 'link' || !node.url) return false;
  const text = plainText(node);
  return node.url === text || node.url === `http://${text}` || node.url === `mailto:${text}`;
}

/** Never looked into: code, raw HTML, and a written link's own text. */
const SKIP = new Set(['code', 'inlineCode', 'html', 'link', 'linkReference', 'definition']);

type People = {
  members: readonly Named[];
  tags: { all: readonly MessageMention[]; pending: MessageMention[] };
  agents: readonly string[];
};

function walk(node: MdNode, people: People): void {
  if (!node.children) return;
  // First, back to plain text: bare links (the Room has its own rules for
  // them) and hard line breaks; an image becomes a link to it.
  const flat: MdNode[] = [];
  for (const child of node.children) {
    let next = child;
    if (isAutolink(child))
      next = { type: 'text', value: plainText(child), position: child.position };
    else if (child.type === 'break') next = { type: 'text', value: '\n' };
    else if (child.type === 'image')
      next = {
        type: 'link',
        url: child.url,
        title: child.title,
        children: [{ type: 'text', value: child.alt || child.url || '' }],
      };
    else if (child.type === 'imageReference') next = { type: 'text', value: child.alt ?? '' };
    const prev = flat.at(-1);
    if (next.type === 'text' && prev?.type === 'text')
      flat[flat.length - 1] = { ...prev, value: `${prev.value ?? ''}${next.value ?? ''}` };
    else flat.push(next);
  }
  const out: MdNode[] = [];
  for (const child of flat) {
    if (child.type === 'text') {
      out.push(...splitTokens(child.value ?? '', child.position?.start.offset === 0, people.members, people.tags, people.agents));
      continue;
    }
    if (!SKIP.has(child.type)) walk(child, people);
    out.push(child);
  }
  node.children = out;
}

/** Just what's needed of unified's processor (not a dependency here). */
type Processor = { data(): object };

/** remark plugin: see the header comment. */
export function remarkRoomTokens(
  this: Processor,
  options: { members?: readonly Named[]; mentions?: readonly MessageMention[]; agents?: readonly string[] } = {}
) {
  const data = this.data() as { micromarkExtensions?: unknown[] };
  // Four leading spaces are someone's indent, not a code block.
  (data.micromarkExtensions ??= []).push({ disable: { null: ['codeIndented'] } });
  const members = options.members ?? [];
  return (tree: MdNode) => {
    const all = options.mentions ?? [];
    walk(tree, { members, tags: { all, pending: [...all] }, agents: options.agents ?? [] });
  };
}
