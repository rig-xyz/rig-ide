/**
 * Follow-up round on the model/effort picker (Dylan's screenshot: "Default
 * (rec…" truncating mid-word). The trigger is a narrow metadata chip, not
 * a place to spell out a full option name with its parenthetical — this
 * strips a trailing `(...)` annotation (e.g. "Default (recommended)" →
 * "Default") for the COMPACT trigger label only. The dropdown's own option
 * rows keep the untouched, full name (`meta-option-picker.tsx`'s render) —
 * nothing is ever hidden at the moment someone is actually choosing.
 */
export function compactOptionLabel(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim() || name;
}
