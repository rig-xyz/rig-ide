/**
 * Follow-up round on the model/effort picker — "remember what I last
 * picked for this harness, apply it once a new session's options arrive."
 * Pure decision only: given what's remembered, what the session just
 * advertised, and whether this store has already applied its one shot,
 * what (if anything) should get auto-applied. The stateful parts — reading
 * the remembered id from `rpc.rig.settings`, the MobX reaction that watches
 * for options to arrive, the one-shot guard flag, actually calling
 * `setModel`/`setEffort` — live in `rig-chat-store.ts`, which is the one
 * caller.
 *
 * "Apply once" is enforced here, not just documented: `alreadyApplied` is
 * an explicit parameter, so a picker re-render or an options list that
 * changes again later (e.g. a permission-mode switch that changes what a
 * model advertises) can never re-trigger — the guard is checked on every
 * call, not just the first.
 */
export function deriveAutoApplyOption(
  rememberedId: string | null,
  availableOptions: readonly { id: string }[],
  alreadyApplied: boolean
): string | null {
  if (alreadyApplied || !rememberedId) return null;
  return availableOptions.some((o) => o.id === rememberedId) ? rememberedId : null;
}
