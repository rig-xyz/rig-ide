/**
 * Pulse's own file-mention linking (Home's WHAT'S NEW / ACROSS YOUR RIGS
 * narration, `briefing-spine.tsx`) — genuinely different shape from chat's
 * `link-file-mentions.ts`: chat already has the open rig's FULL file tree
 * loaded, so it can match straight against a known list of real paths and
 * basenames. Pulse narrates rigs that may not even be open (the rig's OWN
 * folder is resolved main-side, on request, by `rpc.rig.fileMentions.resolve`
 * — see `main/rig/file-mentions.ts`) — there is no tree here to build a
 * candidate index from up front. So this works in two passes instead of one:
 *
 *  1. `extractFileMentionCandidates` — a plain tokenizer over the raw text,
 *     with NO knowledge of which files actually exist: anything that reads
 *     as a bare/quoted/bold/backticked filename (a run containing a dot
 *     followed by an extension the artifact pane can actually show — same
 *     `detectByExtension` allowlist chat's matcher already uses) is a
 *     candidate string, sent to `rpc.rig.fileMentions.resolve` for the main
 *     process to turn into a real relPath (or `null` for "doesn't exist").
 *  2. `linkPulseFileMentions` — once resolved, turns each into a markdown
 *     link. This step DOES reuse `linkFileMentions` (`@renderer/lib/file-
 *     mentions`, the same core chat's matcher runs on) rather than forking
 *     a second scan-and-boundary engine: for every resolved candidate it
 *     registers BOTH a bare pattern and a backtick-wrapped one (mapping to
 *     the same target). A mention actually written backtick-wrapped then
 *     matches the longer, backtick-inclusive pattern (it starts one
 *     character earlier in the text, so it always wins over the bare one —
 *     no extra bookkeeping needed), keeping its code-chip look inside the
 *     link; a quoted/bold/bare mention matches the bare pattern instead,
 *     and its surrounding delimiter is simply never part of any pattern —
 *     the existing boundary rules' own quote/asterisk neutrality already
 *     leaves it untouched, exactly as it does for chat.
 *
 * PURE: no IO. An existing markdown link (`[…](…)`) or a fenced code block
 * is treated as opaque and never touched by either pass — a file mention
 * genuinely INSIDE a code fence is exactly the kind of accidental match
 * this guards against (a snippet mentioning `notes.py` as an example, not a
 * real pointer into the rig).
 */

import { detectByExtension } from '@renderer/features/artifact/file-type';
import { linkFileMentions, type FileMentionCandidate } from '@renderer/lib/file-mentions';

/** An existing markdown link, or a fenced code block — left untouched by both passes below. */
const PROTECTED_RE = /\[[^\]\n]*\]\([^)\n]*\)|```[\s\S]*?```/g;

/**
 * Backtick / bold / double-quoted / single-quoted / bare, in that priority
 * order only because `matchAll` visits alternatives left-to-right when more
 * than one COULD start at the same position — in practice each occurrence
 * is wrapped at most one way, so this rarely matters. The bare alternative
 * is a maximal path-like run ending in `.<ext>`: greedy backtracking
 * naturally lands on the LAST dot as the extension boundary (`file.md.bak`
 * reads as extension `bak`), matching `extensionOf`'s own `lastIndexOf('.')`
 * rule, so `isLinkableCandidate` below agrees with it.
 */
const MENTION_TOKEN_RE =
  /`([^`\n]+)`|\*\*([^*\n]+)\*\*|"([^"\n]+)"|'([^'\n]+)'|((?:\.\/)?[A-Za-z0-9_][A-Za-z0-9_.\-/]*\.[A-Za-z0-9]{1,10})/g;

function isLinkableCandidate(candidate: string): boolean {
  const detected = detectByExtension(candidate);
  return detected?.category === 'markdown' || detected?.category === 'text';
}

/**
 * `text` split into alternating chunks, protected ones (an existing
 * markdown link, a fenced code block) returned verbatim and never handed
 * to either pass above.
 */
function splitProtected(text: string): { value: string; protected: boolean }[] {
  const parts: { value: string; protected: boolean }[] = [];
  let cursor = 0;
  for (const m of text.matchAll(PROTECTED_RE)) {
    if (m.index === undefined) continue;
    if (m.index > cursor) parts.push({ value: text.slice(cursor, m.index), protected: false });
    parts.push({ value: m[0], protected: true });
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length || parts.length === 0) {
    parts.push({ value: text.slice(cursor), protected: false });
  }
  return parts;
}

/**
 * Every distinct candidate string worth asking the main-side resolver
 * about — a bare/quoted/bold/backticked run that LOOKS like a file this app
 * could show, whether or not it actually exists in the rig. Never produced
 * from text inside a fenced code block or an existing markdown link.
 */
export function extractFileMentionCandidates(text: string): string[] {
  const found = new Set<string>();
  for (const part of splitProtected(text)) {
    if (part.protected) continue;
    for (const m of part.value.matchAll(MENTION_TOKEN_RE)) {
      const candidate = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5];
      if (candidate && isLinkableCandidate(candidate)) found.add(candidate);
    }
  }
  return [...found];
}

/** `rpc.rig.fileMentions.resolve`'s own shape — `null` means "checked, doesn't exist"; a key simply absent means "never asked." */
export type ResolvedFileMentions = Record<string, string | null>;

function buildIndex(resolved: ResolvedFileMentions): FileMentionCandidate[] {
  const candidates: FileMentionCandidate[] = [];
  for (const [candidate, relPath] of Object.entries(resolved)) {
    if (!relPath) continue;
    // The backtick-wrapped pattern is two characters longer, so it wins
    // whenever the mention was actually written that way — see this
    // module's own header comment for why that's enough to keep the code-
    // chip look without any per-occurrence delimiter bookkeeping.
    candidates.push({ pattern: `\`${candidate}\``, relPath });
    candidates.push({ pattern: candidate, relPath });
  }
  candidates.sort((a, b) => b.pattern.length - a.pattern.length);
  return candidates;
}

/**
 * Turns every mention in `text` that `resolved` could actually place into a
 * markdown link to `rigfile:<bindingId>/<relPath>` (`relPath` percent-
 * encoded WHOLE, slashes included, so the one literal `/` right after
 * `bindingId` is unambiguous to split back out — see `comment-markdown.tsx`'s
 * `parseRigFileHref`). A candidate `resolved` doesn't have, or maps to
 * `null`, is left exactly as written. Pure: never touches text inside an
 * existing markdown link or a fenced code block.
 */
export function linkPulseFileMentions(
  text: string,
  bindingId: string,
  resolved: ResolvedFileMentions
): string {
  const candidates = buildIndex(resolved);
  if (candidates.length === 0) return text;
  const index = { candidates };

  return splitProtected(text)
    .map((part) => {
      if (part.protected) return part.value;
      return linkFileMentions(part.value, index)
        .map((segment) =>
          segment.path
            ? `[${segment.text}](rigfile:${bindingId}/${encodeURIComponent(segment.path)})`
            : segment.text
        )
        .join('');
    })
    .join('');
}
