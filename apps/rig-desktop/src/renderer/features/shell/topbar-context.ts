/**
 * What the title bar's far-left slot shows, immediately after the traffic
 * lights (header-dedup round, take 3). `kind: 'none'` on Home — no crumb,
 * no title (the briefing spine's greeting already owns identity there).
 * `kind: 'rig'` drives the mini-breadcrumb: [⌂] › (folder) rig-name — the
 * house button is the app's ONE up-navigation affordance (the panel headers
 * below the bar carry none). Pure so the "nothing on Home / crumb once
 * bound" rule is a tested fact, not a read of App.tsx's JSX.
 */
export type TopbarContext = { kind: 'none' } | { kind: 'rig'; name: string; bindingId: string };

export function deriveTopbarContext(
  bound: { name: string | null; bindingId: string } | null
): TopbarContext {
  if (!bound) return { kind: 'none' };
  return { kind: 'rig', name: bound.name ?? 'Unnamed rig', bindingId: bound.bindingId };
}
