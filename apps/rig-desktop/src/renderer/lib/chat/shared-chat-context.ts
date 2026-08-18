import { createChatContext, type ChatContext } from '@emdash/chat-ui';

/**
 * Process-long ChatContext singleton (theme, shared caches, measureEpoch).
 *
 * Simplified from emdash-desktop's version: no mentionProvider/commandProvider.
 * @-mentions and /-commands aren't part of this app's v1 chat scope (see
 * `chat-panel.tsx`'s header note) — the transcript still renders raw @/-
 * text, just without pill/chip decoration. Add providers here if that scope
 * grows.
 */
let shared: ChatContext | null = null;

export function getSharedChatContext(): ChatContext {
  shared ??= createChatContext();
  return shared;
}
