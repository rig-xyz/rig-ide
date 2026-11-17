import { rpc } from '@renderer/lib/ipc';
import { RigChatStore } from '../rig-chat-store';
import { rigSessionRegistry } from './rig-session-registry';

/**
 * A side chat (spike, Rig Alpha): a session of your own in a space, started by you from the Room
 * ("/side …" in the composer, or the "+" under the space's tabs). Only you see it; it opens as a
 * tab beside the Room and is one of the space's own chats like any Rig started for you
 * (`start-in-space.ts`).
 *
 * It starts knowing what the Room was talking about: its first message carries the Room's recent
 * conversation as context the person does not see in the transcript. Nothing it says reaches the
 * Room unless the person posts it there (`postToRoom`).
 */

/** Side chats that have not had their first message: that message takes the Room's context with it. */
const unseeded = new Set<string>();

/** A new side chat in the space, ready for its first message. Returns its session id, to open as a tab. */
export function openSideChat(bindingId: string, root: string): string {
  const id = crypto.randomUUID();
  rigSessionRegistry.attach<RigChatStore>(id, () => new RigChatStore(id, bindingId, root, 'claude'));
  unseeded.add(id);
  return id;
}

/** The Room's recent conversation, as the context a side chat starts from; undefined when it can't be read. */
async function roomContext(bindingId: string): Promise<string | undefined> {
  const result = await rpc.rig.spacesDispatch.roomContext({ bindingId }).catch(() => null);
  if (!result?.success || result.data.lines.length === 0) return undefined;
  return [
    'This is a side chat: a private session the person opened beside the shared Room of this space.',
    'Only they see it, and nothing you say here is posted to the Room; they can post your answer there themselves.',
    'For context, the recent conversation in the Room ("#seq name: text", oldest first):',
    '',
    ...result.data.lines,
  ].join('\n');
}

/** Sends `text` to a side chat; its first message takes the Room's recent conversation along. */
export async function sendToSideChat(store: RigChatStore, text: string): Promise<void> {
  if (!unseeded.delete(store.conversationId)) {
    store.submitPrompt(text);
    return;
  }
  const context = await roomContext(store.rigBindingId);
  store.submitPrompt(text, context);
}

/** Starts a side chat on `text` right away ("/side …"). Returns its session id, to open as a tab. */
export function startSideChat(bindingId: string, root: string, text: string): string {
  const id = openSideChat(bindingId, root);
  const store = rigSessionRegistry.get<RigChatStore>(id);
  if (store && text.trim()) {
    void store.bootstrap().then(() => {
      if (!store.loadError) void sendToSideChat(store, text);
    });
  }
  return id;
}
