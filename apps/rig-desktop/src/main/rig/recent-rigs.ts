import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { desc, sql } from 'drizzle-orm';
import { db } from '@main/db/client';
import { rigRigs, type RigRigRow } from '@main/db/schema';
import { createRPCController } from '@shared/lib/ipc/rpc';

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
}): Promise<void> {
  const now = Date.now();
  await db
    .insert(rigRigs)
    .values({
      id: randomUUID(),
      path: input.path,
      bindingId: input.bindingId,
      name: input.name,
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
      },
    });
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

async function existsAsDirectory(path: string): Promise<boolean> {
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

export const rigRecentController = createRPCController({
  /** Most-recently-opened rigs, newest first — feeds the Home screen's RIGS section. */
  recentRigs: (limit = 10): Promise<RigRigRow[]> => {
    return db.select().from(rigRigs).orderBy(desc(rigRigs.lastOpenedAt)).limit(limit);
  },

  resolveLocalPaths: ({ bindingIds }: { bindingIds: string[] }): Promise<Record<string, string>> =>
    resolveLocalPathsImpl(bindingIds),
});
