/**
 * Pure derivation for the zero-state's default harness — a real preference
 * signal, not a probe-order accident (harness-default round; Dylan opened a
 * brand-new rig and got CODEX because codex's ~40ms probe beat claude's
 * ~1s one to the first snapshot).
 *
 * Preference order:
 *   1. the harness this rig last used (`lastHarnessByRig[bindingId]`),
 *   2. the harness the user most recently STARTED A SESSION with anywhere
 *      (`lastHarness` — a brand-new rig inherits it),
 *   3. probe order: the first live-runnable agent,
 *   4. the first LAST-KNOWN-runnable agent (persisted probe outcome from a
 *      previous run — boot trust while the live probes are still landing).
 *
 * A remembered preference (1/2) is honored when EITHER the live probe has
 * already confirmed it or the last-known set vouches for it — installed
 * CLIs don't vanish between launches, and the live probe re-verifying in
 * the background corrects the choice (callers re-derive on every input
 * change) if it genuinely did.
 */
export function deriveDefaultHarness(input: {
  /** Live probe verdicts, in payload order. */
  runnable: readonly string[];
  /** Persisted verdict from the previous run (`settings.lastKnownRunnableAgents`). */
  lastKnownRunnable: readonly string[];
  lastForRig: string | null;
  lastGlobal: string | null;
}): string | null {
  const vouched = (id: string | null): id is string =>
    id !== null && (input.runnable.includes(id) || input.lastKnownRunnable.includes(id));
  if (vouched(input.lastForRig)) return input.lastForRig;
  if (vouched(input.lastGlobal)) return input.lastGlobal;
  return input.runnable[0] ?? input.lastKnownRunnable[0] ?? null;
}
