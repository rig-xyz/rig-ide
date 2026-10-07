import type { PageAnchor } from '@shared/spaces/pages';

/**
 * Why a pin wasn't placed on a page ('frame gone', 'board gone', 'element
 * gone', 'error'), logged once per page, pin and reason: the panel looks
 * again every couple of seconds. Never the anchor's text or the page's query
 * string, which can carry what's on the page.
 */

/** Plenty for a session's pins; past it the set starts over. */
const MAX_SEEN = 500;

/** A page as the log names it: origin and path, nothing after. */
export function pageForLog(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return 'unknown';
  }
}

export function createPinMissLog(
  write: (message: string, fields: Record<string, unknown>) => void
) {
  const seen = new Set<string>();
  return (
    pageUrl: string,
    pin: { id: string; anchor: PageAnchor },
    why: string | undefined
  ): void => {
    const page = pageForLog(pageUrl);
    const reason = why ?? 'error';
    const key = `${page} ${pin.id} ${reason}`;
    if (seen.has(key)) return;
    if (seen.size >= MAX_SEEN) seen.clear();
    seen.add(key);
    write('Rig pages: a pin was not placed', {
      page,
      pin: pin.id,
      why: reason,
      frameOrigins: pin.anchor.xo.map((hop) => hop.origin),
      boardHops: pin.anchor.hops.length,
      tag: pin.anchor.tag,
    });
  };
}
