import { events } from '@main/lib/events';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { rigDeepLinkJoinChannel, type RigDeepLinkJoin } from '@shared/rig/deep-link';
import { DeepLinkInbox } from './deep-link-inbox';

/**
 * The `rig://join/<secret>` inbox the OS handlers in `main/app/deep-links.ts`
 * push into, and the renderer's confirm dialog
 * (`features/deep-link/deep-link-join-dialog.tsx`) drains. See
 * `./deep-link-inbox.ts` for why links queue until the renderer is ready.
 */
export const deepLinkInbox = new DeepLinkInbox<RigDeepLinkJoin>((request) =>
  events.emit(rigDeepLinkJoinChannel, request)
);

export const rigDeepLinkController = createRPCController({
  /** The confirm dialog mounted: returns a link that arrived before it did, and turns on live delivery. */
  consumePending: (): RigDeepLinkJoin | null => deepLinkInbox.drain(),
  /** The confirm dialog unmounted: queue links again until it's back. */
  release: (): void => deepLinkInbox.reset(),
});
