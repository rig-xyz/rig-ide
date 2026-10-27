import { createRoot, type Root } from 'react-dom/client';
import type { OrchProgressEvent } from '@shared/rig/orch-progress';
import recorded from './fixtures/first-run.json';
import { liveFirstRun, replaySource } from './progress-source';
import { ReadStep } from './read-step';

/**
 * Dev only: the Read step over the app, until the first-run shell mounts it.
 * From the dev app's console:
 *   (await import('/features/first-run/read/dev-preview.tsx')).previewReadStep({ speed: 4 })
 * replays the recorded first run (fixtures/first-run.json) 4× faster;
 * `{ live: true }` runs a real first run instead. Call it again to close.
 */
let open: { root: Root; el: HTMLElement } | null = null;

export function previewReadStep({
  speed = 1,
  live = false,
}: { speed?: number; live?: boolean } = {}): void {
  if (!import.meta.env.DEV) return;
  if (open) {
    open.root.unmount();
    open.el.remove();
    open = null;
    return;
  }
  const el = document.createElement('div');
  // Inline, so it shows whatever classes the running dev server has generated.
  el.style.cssText =
    'position:fixed;top:48px;left:24px;z-index:9999;display:flex;flex-direction:column;height:620px;width:370px;padding:24px;border-radius:16px;border:1px solid var(--border-hairline);background:var(--bg-1);box-shadow:0 20px 60px rgba(0,0,0,.5)';
  document.body.appendChild(el);
  const root = createRoot(el);
  open = { root, el };
  const source = live ? liveFirstRun : replaySource(recorded as OrchProgressEvent[], { speed });
  root.render(
    <ReadStep source={source} onDone={(summary) => console.info('Read step done', summary)} />
  );
}
