import { afterEach, describe, expect, it } from 'vitest';
import '@renderer/features/home-feed/home-feed.css';

/**
 * The rail's thread from a space down to its sessions: each session row's
 * stem meets the next one, so the space's sessions hang off one line, which
 * ends at the middle of the last session.
 */

let host: HTMLDivElement;

afterEach(() => host.remove());

function rows(n: number): HTMLElement[] {
  host = document.createElement('div');
  host.innerHTML = `<div style="height:32px;margin-top:4px">space</div>${Array.from(
    { length: n },
    (_, i) =>
      `<button style="position:relative;display:block;width:240px;min-height:40px;padding:0;border:0">` +
      `<span class="hf-stem"${i === n - 1 ? ' data-last' : ''}></span>row ${i}</button>`
  ).join('')}`;
  document.body.appendChild(host);
  return [...host.querySelectorAll<HTMLElement>('.hf-stem')];
}

describe('the rail stem', () => {
  it("is one line: each session's stem reaches the next, with no gap", () => {
    const stems = rows(3).map((s) => s.getBoundingClientRect());
    for (let i = 1; i < stems.length; i++) {
      expect(stems[i].top).toBeLessThanOrEqual(stems[i - 1].bottom);
      expect(stems[i].left).toBe(stems[i - 1].left);
    }
  });

  it('hangs from the space above and ends at the middle of the last session', () => {
    const stems = rows(2);
    const first = stems[0].getBoundingClientRect();
    const lastRow = stems[1].parentElement!.getBoundingClientRect();
    expect(first.top).toBeLessThan(stems[0].parentElement!.getBoundingClientRect().top);
    expect(stems[1].getBoundingClientRect().bottom).toBeCloseTo(lastRow.top + lastRow.height / 2, 0);
  });
});
