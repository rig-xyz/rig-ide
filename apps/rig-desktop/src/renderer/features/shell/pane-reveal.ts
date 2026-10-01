import { cn } from '@renderer/lib/utils';

/**
 * Doc-focus round: the artefact pane's own open transition — a doc opening
 * beside the Room/session (any layout flip away from 'chat' in `App.tsx`)
 * gets a short reveal instead of a jump. Transform + opacity only, never
 * `width` — so it can't fight the split resize handle's own perf fix
 * (`App.tsx`'s `ChatDivider`, which still only ever commits a plain
 * flex width, never a measured/animated one). ~200ms ease-out;
 * `motion-reduce:` drops it to instant.
 *
 * A standalone module (not inlined in `App.tsx`'s JSX) so it has a plain
 * unit test with no need to mount `App` itself, which needs a real bound
 * rig and a pile of IPC mocks (`window.electronAPI`) to reach this deep.
 */
export function paneRevealClassName(entered: boolean): string {
  return cn(
    'origin-left transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none',
    entered ? 'scale-x-100 opacity-100' : 'scale-x-[0.98] opacity-0'
  );
}
