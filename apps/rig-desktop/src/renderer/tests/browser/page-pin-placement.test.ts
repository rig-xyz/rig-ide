import { afterEach, describe, expect, it } from 'vitest';
import { frameBoardSnapshot, frameCall, framePin, type PageAnchor } from '@main/rig/pages/page-frame-scripts';

/**
 * Comments and pins spike (rig docs/comments-pins-spike.md), surfaces 4 and
 * 5. Every test here fails today. Like `page-frame-scripts.test.ts`, the
 * frame scripts run from `frameCall`'s serialized source, as they do in a
 * page.
 *
 * A pin is found again by its CSS path (nth-of-type steps), checked against
 * the element's text when it had any, else by the first element of the same
 * tag with the same text. That loses a pin whose element only changed its
 * words, and silently moves a pin when the path now names a sibling.
 */
const inject = <T,>(source: string): T => new Function(`return ${source}`)() as T;
const hit = (x: number, y: number) => inject<PageAnchor>(frameCall(framePin, 'hit', { x, y }));
type Found = { found: boolean; why?: string; x: number; y: number; w: number; h: number };
const locate = (a: PageAnchor) => inject<Found>(frameCall(framePin, 'locate', a));

let host: HTMLDivElement;
function mount(html: string): HTMLDivElement {
  host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:0;top:0;width:400px;font:14px sans-serif';
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}
const centre = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};
/** Distance from where a pin was found to the centre of `el` (the pin was made at its centre). */
const offBy = (found: Found, a: PageAnchor, el: Element) => {
  const c = centre(el);
  return Math.hypot(found.x - (a.fx - 0.5) * found.w - c.x, found.y - (a.fy - 0.5) * found.h - c.y);
};

afterEach(() => host?.remove());

// Sturdier page anchors (fix 6 in the spike doc) are left for later: these
// still fail, marked `it.fails` so the suite stays green. Drop `.fails` when
// that lands.
describe('a pin after its page changes', () => {
  it.fails("stays on a number whose value changed (a dashboard's total)", () => {
    const root = mount('<h3>Pipeline</h3><p><span>Total</span> <b id="total">312</b></p>');
    const total = root.querySelector('#total')!;
    const a = hit(centre(total).x, centre(total).y);
    expect(a.text).toBe('312');
    total.textContent = '398';
    // Today: { found: false, why: 'element gone' }, though the element is right there.
    expect(locate(a)).toMatchObject({ found: true });
  });

  it.fails('stays on its chart bar when a bar is added before it', () => {
    const root = mount(
      '<svg width="300" height="120"><rect x="10" y="40" width="30" height="80"/><rect x="60" y="10" width="30" height="110"/></svg>'
    );
    const second = root.querySelectorAll('rect')[1]!;
    const a = hit(centre(second).x, centre(second).y);
    expect(a.tag).toBe('rect');
    // New data: a bar drawn first, the old ones shift right.
    const svg = root.querySelector('svg')!;
    const added = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    for (const [k, v] of Object.entries({ x: '110', y: '60', width: '30', height: '60' })) added.setAttribute(k, v);
    svg.insertBefore(added, svg.firstChild);
    second.setAttribute('x', '160');
    const found = locate(a);
    // Today: found on the first old bar (now the second rect), with no sign it moved.
    expect(found.found ? offBy(found, a, second) : 0).toBeLessThan(2);
  });

  it.fails('stays on its row when a row with the same button is added above', () => {
    const row = (name: string) => `<li><span>${name}</span> <button>Edit</button></li>`;
    const root = mount(`<ul>${row('Alpha')}${row('Beta')}${row('Gamma')}</ul>`);
    const gammaEdit = root.querySelectorAll('button')[2]!;
    const a = hit(centre(gammaEdit).x, centre(gammaEdit).y);
    expect(a).toMatchObject({ tag: 'button', text: 'Edit' });
    root.querySelector('ul')!.insertAdjacentHTML('afterbegin', row('New'));
    const found = locate(a);
    // Today: found on Beta's Edit button (same path, same text).
    expect(found.found ? offBy(found, a, gammaEdit) : 0).toBeLessThan(2);
  });

  it.fails('is not drawn over other content when its element is scrolled out of an inner scroller', () => {
    // Most web apps scroll inside a panel, not the window.
    const root = mount(
      '<header style="height:40px">Toolbar</header><div id="scroller" style="height:120px;overflow:auto">' +
        Array.from({ length: 20 }, (_, i) => `<p style="margin:0;height:30px">Line ${i}</p>`).join('') +
        '</div><footer style="height:200px">Footer</footer>'
    );
    const scroller = root.querySelector('#scroller')!;
    const line2 = scroller.querySelectorAll('p')[2]!;
    const a = hit(centre(line2).x, centre(line2).y);
    expect(a.text).toBe('Line 2');
    scroller.scrollTop = 200; // Line 2 is now above the scroller's visible box, behind the toolbar.
    const found = locate(a);
    const box = scroller.getBoundingClientRect();
    // Today: found, at a point above the scroller (over the toolbar).
    const visible = !found.found || (found.y >= box.top && found.y <= box.bottom);
    expect(visible).toBe(true);
  });
});

describe('agents and pins on a page without boards', () => {
  it("rig_browser_screenshot finds a pin's element on a plain page", () => {
    const root = mount('<h1>Launch notes</h1><p id="p">Ship date moves to the 14th.</p>');
    const p = root.querySelector('#p')!;
    const a = hit(centre(p).x, centre(p).y);
    expect(a.hops).toEqual([]);
    // What `rig_browser_screenshot` asks for with `pin` (browser-tools.ts).
    const snap = inject<{ el: unknown } | null>(
      frameCall(frameBoardSnapshot, { sig: a.hops[0]?.sig, index: a.hops[0]?.index, path: a.path, text: a.text || undefined })
    );
    // Today: null (it only looks inside iframes), so the agent is told
    // "Pin N's element isn't on the page any more" while rig_browser_pins
    // and the person both see it.
    expect(snap?.el ?? null).not.toBeNull();
  });
});
