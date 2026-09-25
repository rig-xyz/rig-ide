import { describe, expect, it } from 'vitest';
// `App.tsx` itself can't be imported from a plain node test — it transitively
// pulls in `lib/ipc.ts`, which touches `window.electronAPI` at module scope.
// `paneRevealClassName` lives in its own small module for exactly this
// reason; this file keeps the `App.test.ts` name since it exercises what
// `App.tsx`'s own artefact-pane render uses it for.
import { paneRevealClassName } from './features/shell/pane-reveal';

/**
 * Split-resize/doc-focus round: `paneRevealClassName` is the artefact
 * pane's own open transition — a doc opening beside the Room/session gets
 * a short reveal instead of a jump (see the pane's own render comment in
 * `App.tsx`). Plain unit test since mounting `App` itself needs a bound
 * rig and a pile of IPC mocks to reach this deep.
 */
describe('paneRevealClassName', () => {
  it('carries the ~200ms ease-out transition, reduced-motion safe', () => {
    const className = paneRevealClassName(false);
    expect(className).toContain('duration-200');
    expect(className).toContain('ease-out');
    expect(className).toContain('motion-reduce:transition-none');
  });

  it('never animates width — transform + opacity only, so it can\'t fight the split resize handle', () => {
    expect(paneRevealClassName(true)).not.toMatch(/\bwidth\b/);
    expect(paneRevealClassName(false)).not.toMatch(/\bwidth\b/);
  });

  it('starts hidden and reveals once entered', () => {
    expect(paneRevealClassName(false)).toContain('opacity-0');
    expect(paneRevealClassName(true)).toContain('opacity-100');
  });
});
