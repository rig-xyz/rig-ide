import { defineEvent } from '../lib/ipc/events';

/**
 * An agent moving its asker's view (`rig_browser_open`, `rig_topic_show`):
 * main asks this Mac's window to show something in a space. Only ever sent
 * when the person who asked is the one signed in here.
 */
export type RigShowRequest =
  /** A web page beside the chat. */
  | { kind: 'page'; bindingId: string; url: string; passage?: string }
  /** A file in the space: html in Browser mode, anything else in the file viewer. */
  | { kind: 'file'; bindingId: string; relPath: string; passage?: string; line?: number }
  /** The Room filtered to one topic, as clicking its pill does. */
  | { kind: 'topic'; bindingId: string; themeId: string };

export const rigShowChannel = defineEvent<RigShowRequest>('rig:show');
