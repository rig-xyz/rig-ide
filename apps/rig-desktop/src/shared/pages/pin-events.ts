import { defineEvent } from '../lib/ipc/events';

/**
 * A panel page moved (scrolled, resized, zoomed, changed): its pins should
 * be looked for again. Sent by main from the page's watcher
 * (`main/rig/pages/pin-watch.ts`), throttled; carries only which page.
 */
export const pagePinsMovedChannel = defineEvent<{ webContentsId: number }>('rig:page-pins-moved');
