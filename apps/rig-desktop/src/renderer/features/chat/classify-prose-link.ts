import type { RigFileNode } from '@shared/rig/files';

/**
 * Classifies an `href` off a rendered transcript link for chat-ui's
 * `classifyLink` command (`packages/chat-ui/src/commands.ts`) — the hook
 * `Prose.tsx` already calls synchronously on click, before deciding whether
 * to `preventDefault()` and route through `onOpenFile` instead of letting
 * the `<a target="_blank">` navigate normally.
 *
 * Founder-dogfooding bug this exists to fix: the assistant renders bare
 * relative paths as link text (`CLAUDE.md`, `exercises.md`, `rig.toml`) —
 * chat-ui's markdown parser passes those straight through as `href` with no
 * normalization (`parse.ts`'s `link` case). Clicking used to fall through to
 * a real `<a>` navigation, which the (now-hardened) main-process
 * `setWindowOpenHandler` denies outright — so an unresolved link is a quiet
 * no-op, never a blank window. A workspace-relative path that genuinely
 * exists in the open rig's file tree should instead open in the artifact
 * view, same as clicking it in the file tree itself.
 *
 * Only bare relative paths are resolved — anything with a URL scheme
 * (`http:`, `mailto:`, …), a protocol-relative `//`, a fragment `#…`, or a
 * leading `/` (absolute) is left as `'external'` and takes the default
 * click behavior. `tree` is the SAME `RigFileNode[]` `file-tree.tsx` lists
 * (its react-query cache, read synchronously by the caller — see
 * `chat-panel.tsx`) — a link is only ever classified as a workspace file
 * when it names something the tree actually shows right now.
 */
export function classifyProseLink(
  href: string,
  tree: readonly RigFileNode[] | undefined
): { kind: 'workspace-file'; path: string } | { kind: 'external' } {
  const relPath = normalizeRelativeFilePath(href);
  if (relPath && tree) {
    const node = findFileNode(tree, relPath);
    if (node) return { kind: 'workspace-file', path: node.relPath };
  }
  return { kind: 'external' };
}

/** A candidate relPath to look up in the tree, or `null` for anything that isn't a bare relative path. */
function normalizeRelativeFilePath(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  // A URL scheme (http:, mailto:, file:, …) — never a workspace-relative path.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/')) return null;

  let decoded: string;
  try {
    decoded = decodeURI(trimmed);
  } catch {
    decoded = trimmed;
  }
  const stripped = decoded.replace(/^\.\//, '');
  if (!stripped || stripped.split('/').includes('..')) return null;
  return stripped;
}

function findFileNode(nodes: readonly RigFileNode[], relPath: string): RigFileNode | null {
  for (const node of nodes) {
    if (node.kind === 'file' && node.relPath === relPath) return node;
    if (node.kind === 'dir' && node.children) {
      const found = findFileNode(node.children, relPath);
      if (found) return found;
    }
  }
  return null;
}
