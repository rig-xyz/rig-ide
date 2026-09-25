/**
 * What the title bar's far-left slot shows, immediately after the traffic
 * lights (header-dedup round, take 3). `kind: 'none'` on Home — no crumb,
 * no title (the briefing spine's greeting already owns identity there).
 * `kind: 'rig'` drives the mini-breadcrumb: [⌂] › (folder) rig-name — the
 * house button is the app's ONE up-navigation affordance (the panel headers
 * below the bar carry none). Pure so the "nothing on Home / crumb once
 * bound" rule is a tested fact, not a read of App.tsx's JSX.
 */
export type TopbarContext =
  | { kind: 'none' }
  | { kind: 'rig'; name: string; bindingId: string; path: string };

export function deriveTopbarContext(
  bound: { name: string | null; bindingId: string; path: string } | null
): TopbarContext {
  if (!bound) return { kind: 'none' };
  return { kind: 'rig', name: bound.name ?? 'Unnamed rig', bindingId: bound.bindingId, path: bound.path };
}

/**
 * Whether the bound rig is a space — drives the `#` crumb, the Room in the
 * chat slot, and the People/Share split. The workspaces listing is the
 * authority once it names the binding; until then (a space created or
 * joined a moment ago isn't in the cached listing yet) an open that was
 * started as a space counts as one, so the bar never shows the plain-rig
 * form first and then flips (0.4.3).
 */
export function deriveBoundIsSpace({
  spacesEnabled,
  bindingId,
  listedKind,
  openedAsSpace,
}: {
  spacesEnabled: boolean;
  /** The bound rig's binding, or null when nothing is bound. */
  bindingId: string | null;
  /** The binding's `kind` in the workspaces listing, or undefined while the listing doesn't name it. */
  listedKind: 'rig' | 'space' | undefined;
  /** The current open was started as a space (create, join). */
  openedAsSpace: boolean;
}): boolean {
  if (!spacesEnabled || !bindingId) return false;
  return listedKind ? listedKind === 'space' : openedAsSpace;
}
