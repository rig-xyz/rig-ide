/**
 * Agents write file paths into their answers as bare text or `inline code`
 * — often the absolute path on the computer that ran them
 * (`/Users/dylan/Rig/clear-harbor/release-notes.md`), which means nothing
 * on anyone else's. This remark step turns each such path into a link node
 * (url = the path as written), so the caller's link renderer can resolve it
 * against the space and show it the same way as any other file link: by
 * its path inside the space, opening this computer's copy.
 *
 * Only absolute paths under a home or volume (and `file://` URLs) are taken
 * — `/etc/hosts` or a `/command` stays text. Links, code blocks and HTML
 * are left alone. Structural node types only (no mdast dependency).
 */

type MdNode = { type: string; value?: string; url?: string; children?: MdNode[] };

const PATH_SOURCE = String.raw`(?:file:\/\/)?\/(?:Users|home|Volumes|private|tmp)\/[^\s\x60'"<>()\[\]{}|]+`;
/** A path inside running text: not glued to a word or another path before it. */
const PATH_IN_TEXT = new RegExp(String.raw`(?<![\w/.:~-])${PATH_SOURCE}`, 'g');
const WHOLE_PATH = new RegExp(`^${PATH_SOURCE}$`);

/** The sentence's own punctuation after a path isn't part of it. */
function trimTrailing(path: string): string {
  return path.replace(/[.,;:!?]+$/, '');
}

function splitText(value: string): MdNode[] | null {
  const out: MdNode[] = [];
  let last = 0;
  let found = false;
  for (const match of value.matchAll(PATH_IN_TEXT)) {
    const path = trimTrailing(match[0]);
    if (!path || path.split('/').filter(Boolean).length < 3) continue;
    const at = match.index!;
    if (at > last) out.push({ type: 'text', value: value.slice(last, at) });
    out.push({ type: 'link', url: path, children: [{ type: 'text', value: path }] });
    last = at + path.length;
    found = true;
  }
  if (!found) return null;
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
  return out;
}

const SKIP = new Set(['link', 'linkReference', 'definition', 'code', 'html', 'image', 'imageReference']);

function walk(node: MdNode): void {
  if (!node.children) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && child.value) {
      const parts = splitText(child.value);
      if (parts) {
        next.push(...parts);
        continue;
      }
    } else if (child.type === 'inlineCode' && child.value && WHOLE_PATH.test(child.value.trim())) {
      const path = trimTrailing(child.value.trim());
      next.push({ type: 'link', url: path, children: [{ type: 'inlineCode', value: path }] });
      continue;
    } else if (!SKIP.has(child.type)) {
      walk(child);
    }
    next.push(child);
  }
  node.children = next;
}

/** remark plugin: bare absolute paths → links (see the header comment). */
export function remarkBarePaths() {
  return (tree: MdNode) => {
    walk(tree);
  };
}
