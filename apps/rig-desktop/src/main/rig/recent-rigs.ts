import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '@main/db/client';
import { rigRigs, type RigRigRow } from '@main/db/schema';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { isInsideHome, readRigHomeDir } from './home';
import { isRigSyncPaused } from './sync-paused';

/**
 * Recent-rigs bookkeeping (`persistence-design.md` Round A) — one `rig_rigs`
 * row per bound rig, upserted on every successful open (see the call site in
 * `workspace.ts`'s `detect`). `bindingId`, not `path`, is the upsert key: a
 * rig's local path can change (moved, re-cloned) while the binding id — read
 * from `.rig/tap-binding.local.json` — can't, so `path` is refreshed as
 * best-effort display info on every open rather than being unique itself.
 */
export async function recordRigOpened(input: {
  path: string;
  bindingId: string;
  name: string | null;
  /**
   * Accounts & rigs round: the signed-in account's stable id to stamp on
   * this row — `null` when signed out, or `undefined` when the caller
   * couldn't confidently tell (a relay hiccup while signed in — see
   * `account.ts`'s `CurrentAccountId`). `undefined` leaves whatever
   * account this row already had untouched (on both insert and update it
   * still needs SOME value, so a brand-new row from an `undefined` caller
   * starts out null, same as a legacy row) rather than clobbering good
   * data with a guess.
   */
  accountId?: string | null;
}): Promise<void> {
  const now = Date.now();
  await db
    .insert(rigRigs)
    .values({
      id: randomUUID(),
      path: input.path,
      bindingId: input.bindingId,
      name: input.name,
      accountId: input.accountId ?? null,
      firstOpenedAt: now,
      lastOpenedAt: now,
      openCount: 1,
    })
    .onConflictDoUpdate({
      target: rigRigs.bindingId,
      set: {
        path: input.path,
        name: input.name,
        lastOpenedAt: now,
        openCount: sql`${rigRigs.openCount} + 1`,
        ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
      },
    });
}

/**
 * The account currently recorded for `bindingId`'s row — `undefined` when
 * there's no row at all (never opened locally before), distinct from
 * `null` (a row exists but has no account stamped: a legacy row, or one
 * written while signed out). Used by `workspace.ts`'s `detect` to decide
 * whether opening this folder would be opening someone else's account's
 * rig — see `shared/rig/workspace.ts`'s `isForeignAccountRow`.
 */
export async function getRigAccountId(bindingId: string): Promise<string | null | undefined> {
  const [row] = await db
    .select({ accountId: rigRigs.accountId })
    .from(rigRigs)
    .where(eq(rigRigs.bindingId, bindingId))
    .limit(1);
  return row ? row.accountId : undefined;
}

/**
 * The pure half of "which rigs does `auth.ts`'s logout/login pause/resume —
 * a plain filter+map, kept separate from the db read below so it's
 * unit-testable without touching sqlite.
 */
export function selectRigPathsForAccount(
  rows: readonly { accountId: string | null; path: string }[],
  accountId: string
): string[] {
  return rows.filter((r) => r.accountId === accountId).map((r) => r.path);
}

/** Every local path recorded for `accountId` — `auth.ts`'s logout (pause) and login (resume) hooks. */
export async function getRigPathsForAccount(accountId: string): Promise<string[]> {
  const rows = await db.select({ accountId: rigRigs.accountId, path: rigRigs.path }).from(rigRigs);
  return selectRigPathsForAccount(rows, accountId);
}

/**
 * Updates ONLY the path for an existing `rig_rigs` row — the row menu's
 * "Move to Rig folder" (`rig-controls.ts`'s `moveRig`) after a successful
 * `rig move`. Deliberately narrower than `recordRigOpened`: a move is not
 * an "open" (no `lastOpenedAt`/`openCount` bump).
 */
export async function updateRigPath(bindingId: string, newPath: string): Promise<void> {
  await db.update(rigRigs).set({ path: newPath }).where(eq(rigRigs.bindingId, bindingId));
}

/**
 * Updates ONLY the name for an existing `rig_rigs` row — the row menu's
 * "Rename…" (`rename.ts`'s `renameRig`), after the `rig.toml` write on disk
 * succeeds. Mirrors `updateRigPath` above; a binding with no local row yet
 * (nothing to rename locally) is simply a no-op — `renameRig` never reaches
 * this without one, since it operates on an already-open local rig.
 */
export async function updateRigName(bindingId: string, newName: string): Promise<void> {
  await db.update(rigRigs).set({ name: newName }).where(eq(rigRigs.bindingId, bindingId));
}

// ── resolveLocalPaths (correction round — the scan is gone) ────────────────
//
// A prior round of this tried to close the "already synced via the CLI,
// never opened through this app" gap with a bounded local filesystem scan.
// Correctly rejected: an app enumerating folders on someone's machine
// without being asked is not something people want, full stop — no amount
// of "bounded" or "just one level deep" makes that the right call. Deleted
// entirely, not tuned down.
//
// Known-local is now `rig_rigs` ONLY — existence-verified (a recorded path
// can still have been deleted or moved since). Everything else genuinely
// unknown-to-this-device goes through explicit, user-consented paths
// instead: "Download" (mint + `rig join` into a folder the user picks via
// a real dialog) or "Locate…" (the user points at a folder they already
// have, and this reads + verifies its OWN `.rig/tap-binding.local.json` —
// one directory, chosen and confirmed by the person, never discovered).

/** Exported for `rig-controls.ts`'s account-scoped pause/resume — same existence check, same "don't fail on a since-deleted folder" tolerance. */
export async function existsAsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * For each of `bindingIds`, the local directory `rig_rigs` already has on
 * record for it — existence-verified, so a folder that's since been
 * deleted or moved doesn't get offered as "Open." Bindings with no local
 * row at all are simply absent from the result (never a null entry — the
 * Home screen's `deriveRelayOnlyAction` already treats "not present" as
 * "no local copy").
 */
export async function resolveLocalPathsImpl(bindingIds: readonly string[]): Promise<Record<string, string>> {
  const wanted = new Set(bindingIds);
  const rows = await db.select({ bindingId: rigRigs.bindingId, path: rigRigs.path }).from(rigRigs);

  const verified: Record<string, string> = {};
  for (const row of rows) {
    if (!wanted.has(row.bindingId)) continue;
    if (await existsAsDirectory(row.path)) verified[row.bindingId] = row.path;
  }
  return verified;
}

/** One `rig_rigs` row, enriched with the three live-filesystem facts the rigs rail's row menu needs — none are stored, all are cheap per-known-path checks (no scanning). */
export type RecentRigRow = RigRigRow & {
  /** `.rig/sync-paused.json`'s flag, read fresh — see `sync-paused.ts`. */
  paused: boolean;
  /** True when this rig's path is NOT inside the managed Rig home — gates the row menu's "Move to Rig folder" and the "custom location" affordance. */
  outsideHome: boolean;
  /**
   * Dead-end fix — true when `path` no longer carries a rig marker at all
   * (see `hasRigMarker`): the folder was moved, deleted, or simply stopped
   * being a rig (its `.rig`/`rig.toml` removed) since it was last opened
   * here, without the row ever being cleaned up. Never used to filter the
   * row out — only to render it honestly (`rigs-rail.tsx`) and to gate the
   * not-a-rig card's "Remove from your rigs" (`recentRigs`'s own doc
   * comment on why known-local stays `rig_rigs`-only, filesystem scan
   * removed entirely).
   */
  notARigAnymore: boolean;
};

/**
 * Whether `path` itself still carries a rig marker — `rig.toml` (a
 * local-only or synced rig's own manifest) or a `.rig/` directory (holds
 * `tap-binding.local.json` for a synced one, but its bare presence already
 * says "this was set up as a rig"). Checked directly in `path`, no
 * ancestor walk — unlike `binding.ts`'s `findBindingConfig`, which answers
 * a different question ("is this an ANCESTOR's rig"), this is "is `path`
 * ITSELF still one." Existence-verified like `existsAsDirectory` above: a
 * stat that throws (deleted, moved, permissions) just means "no marker,"
 * never a thrown error.
 */
export async function hasRigMarker(path: string): Promise<boolean> {
  const [tomlIsFile, dotRigIsDir] = await Promise.all([
    stat(join(path, 'rig.toml'))
      .then((s) => s.isFile())
      .catch(() => false),
    stat(join(path, '.rig'))
      .then((s) => s.isDirectory())
      .catch(() => false),
  ]);
  return tomlIsFile || dotRigIsDir;
}

/**
 * `recentRigs`'s own body, pulled out for direct testing (same reason
 * `resolveLocalPathsImpl` above is its own function) — most-recently-opened
 * rigs, newest first, each enriched with `paused`/`outsideHome` plus
 * (dead-end fix) `notARigAnymore` from `hasRigMarker`.
 */
export async function recentRigsImpl(limit = 10): Promise<RecentRigRow[]> {
  const rows = await db.select().from(rigRigs).orderBy(desc(rigRigs.lastOpenedAt)).limit(limit);
  const home = await readRigHomeDir();
  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      paused: await isRigSyncPaused(row.path),
      outsideHome: !isInsideHome(row.path, home),
      notARigAnymore: !(await hasRigMarker(row.path)),
    }))
  );
}

/**
 * Deletes a `rig_rigs` row outright — the not-a-rig card's "Remove from
 * your rigs" (`App.tsx`'s `FolderResult`), for a stale row whose folder no
 * longer detects as a rig (moved, deleted, or repurposed since it was last
 * opened here). Local bookkeeping only: never touches the folder on disk,
 * never calls the relay or the CLI — nothing to undo if this rig really is
 * still out there under a different path.
 */
export async function forgetRig(bindingId: string): Promise<void> {
  await db.delete(rigRigs).where(eq(rigRigs.bindingId, bindingId));
}

/**
 * Backfill half of Part B (feedback round, docs/onboarding-flow-spec.md
 * "Accounts & rigs"): `home.tsx` recognizes a legacy (`accountId: null`)
 * row as the signed-in account's own once its bindingId shows up in that
 * account's relay workspaces (`rpc.rig.account.workspaces()`) — this
 * stamps `accountId` onto every such row so future reads stop depending on
 * re-deriving ownership from the relay every render. Idempotent: the
 * `WHERE accountId IS NULL` guard means a row that's already stamped (by
 * this, by `recordRigOpened`, or by a previous call with the same
 * bindingIds) is left untouched — this can never clobber a DIFFERENT
 * account's own stamp, and calling it repeatedly with the same input is a
 * no-op after the first time.
 */
export async function backfillAccountIdImpl(bindingIds: readonly string[], accountId: string): Promise<void> {
  if (bindingIds.length === 0) return;
  await db
    .update(rigRigs)
    .set({ accountId })
    .where(and(isNull(rigRigs.accountId), inArray(rigRigs.bindingId, [...bindingIds])));
}

export const rigRecentController = createRPCController({
  /** Most-recently-opened rigs, newest first — feeds the Home screen's RIGS section. */
  recentRigs: recentRigsImpl,

  resolveLocalPaths: ({ bindingIds }: { bindingIds: string[] }): Promise<Record<string, string>> =>
    resolveLocalPathsImpl(bindingIds),

  /** The not-a-rig card's "Remove from your rigs". */
  forget: ({ bindingId }: { bindingId: string }): Promise<void> => forgetRig(bindingId),

  /** `home.tsx`'s Part B backfill, once a legacy row is confirmed as the signed-in account's own. */
  backfillAccountId: ({ bindingIds, accountId }: { bindingIds: string[]; accountId: string }): Promise<void> =>
    backfillAccountIdImpl(bindingIds, accountId),
});
