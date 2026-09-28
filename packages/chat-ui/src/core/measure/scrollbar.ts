/**
 * scrollbar — thickness of a horizontal scrollbar drawn by a scroller class.
 *
 * 0 where scrollbars overlay content (macOS default); the track height where
 * they take up space (Windows/Linux, macOS "always show scrollbars").
 * Fixed-height horizontal scrollers (tables, code blocks) add it to their
 * reserved height when their content overflows, so the track never covers
 * the last row. Probed once per class (a system setting change applies on
 * the next launch); 0 outside a DOM.
 */

const cache = new Map<string, number>();

export function horizontalScrollbarHeight(className: string): number {
  if (typeof document === 'undefined' || !document.body) return 0;
  let height = cache.get(className);
  if (height === undefined) {
    const probe = document.createElement('div');
    probe.className = className;
    probe.style.cssText =
      'position:absolute;top:0;left:0;width:40px;height:40px;visibility:hidden;' +
      'overflow-x:scroll;overflow-y:hidden;border:0;padding:0';
    document.body.appendChild(probe);
    height = probe.offsetHeight - probe.clientHeight;
    probe.remove();
    cache.set(className, height);
  }
  return height;
}
