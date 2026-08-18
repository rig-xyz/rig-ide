/**
 * Pure decision logic for round F's "resume must never blank the room" fix.
 *
 * Repro: reopening a stored session showed "Loading chat…" full-panel for up
 * to a minute, sometimes ending in "Failed to load chat. Timed out resuming
 * ACP session" — replacing the transcript we already had cached locally
 * (`rig_session_events`) with a spinner or an error screen, even though
 * nothing about the resume actually needs that history to disappear.
 *
 * Two independent decisions live here, both kept IO-free so they're testable
 * without a store, a session, or a clock:
 *
 * 1. `deriveTranscriptPanelMode` — should the transcript panel show a
 *    full-panel takeover (spinner / error screen) or stay showing whatever
 *    history is already seeded, with a quiet inline status/error line
 *    instead? Only "nothing seeded yet" (a genuinely brand-new session, or a
 *    resume with no local cache at all) still earns the full-panel
 *    treatment — the case this app actually holds history for locally is
 *    exactly the case that should never blank.
 *
 * 2. `decideSubmitDisposition` — what happens when the user submits a
 *    prompt. `RigChatStore.submitPrompt` used to do
 *    `this.session?.sendPrompt(...)`, which silently no-ops while `session`
 *    is still null (bootstrapping or resuming) — a genuinely lost message,
 *    not a queued one. This is the fix's decision core: `'hold'` when the
 *    session doesn't exist yet, so the store can hold the text and flush it
 *    (in order) the instant the session connects, instead of dropping it.
 */

export type TranscriptPanelMode =
  | { kind: 'fullPanelLoading' }
  | { kind: 'fullPanelError' }
  | { kind: 'transcript'; inlineError: boolean };

export function deriveTranscriptPanelMode(input: {
  loading: boolean;
  hasError: boolean;
  hasSeededHistory: boolean;
}): TranscriptPanelMode {
  if (!input.hasSeededHistory) {
    if (input.hasError) return { kind: 'fullPanelError' };
    if (input.loading) return { kind: 'fullPanelLoading' };
  }
  return { kind: 'transcript', inlineError: input.hasSeededHistory && input.hasError };
}

export type SubmitDisposition = 'send' | 'queue' | 'hold';

export function decideSubmitDisposition(input: {
  sessionReady: boolean;
  isWorking: boolean;
}): SubmitDisposition {
  if (!input.sessionReady) return 'hold';
  return input.isWorking ? 'queue' : 'send';
}

/**
 * Round: eager session activation — "resume without a message." Typing +
 * sending in a replay tab already resumes (`submitInReplay`); this decides
 * when the composer should ALSO offer an explicit Resume button in that
 * same action slot, no text required. True only where resuming is
 * genuinely real (`canResumeSession`) and there's nothing typed yet — the
 * moment there's text, Send already does the identical resume-then-send in
 * one action, so the button steps aside rather than duplicating it.
 */
export function shouldShowResumeButton(input: {
  hasReplaySession: boolean;
  canResume: boolean;
  hasTypedText: boolean;
}): boolean {
  return input.hasReplaySession && input.canResume && !input.hasTypedText;
}
