import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { log } from '@main/lib/logger';
import { telemetryService } from '@main/lib/telemetry';
import { scrubVersion } from '@main/lib/telemetry-scrub';
import type { SyncHealth } from '@shared/rig/sync-health';
import { getCurrentAccountId } from './account';
import { readBundledCliVersions, resolveCliBin } from './bundled-cli';
import { getLinkedPathsForAccount } from './recent-rigs';
import { getAccountBindingIds, readShownSyncHealth } from './sync-health';
import { syncProblemsFrom, type TapdStatus } from './sync-problems';

/**
 * Watches the sync of this account's rigs and spaces on this computer and
 * sends `sync_problem` when one turns unhealthy (see `sync-problems.ts`).
 * Only while error reports are on: otherwise it never asks the sync process
 * anything. The telemetry service keeps it to once per space, reason and day.
 */

const TAPD_STATUS_TIMEOUT_MS = 15_000;
const FIRST_CHECK_MS = 3 * 60_000;
const CHECK_EVERY_MS = 30 * 60_000;

/** `tapd status --dir <root> --json` for one folder, or null when it can't answer. */
export function readTapdStatus(root: string): Promise<TapdStatus | null> {
  return new Promise((done) => {
    execFile(
      resolveCliBin('tapd'),
      ['status', '--dir', root, '--json'],
      { timeout: TAPD_STATUS_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error && !stdout) return done(null);
        try {
          const parsed: unknown = JSON.parse(String(stdout));
          done(typeof parsed === 'object' && parsed !== null ? (parsed as TapdStatus) : null);
        } catch {
          done(null);
        }
      }
    );
  });
}

/** A space's key for "once a day": a hash of its folder, never its name, id or path. */
function spaceKey(root: string): string {
  return createHash('sha256').update(resolve(root)).digest('hex').slice(0, 16);
}

/** Folder → when it was first seen offline in a row of checks. */
const offlineSince = new Map<string, number>();

export async function checkSyncProblems(now = Date.now()): Promise<void> {
  if (!telemetryService.canSendErrorReports()) return;
  const account = await getCurrentAccountId();
  if (account.status !== 'known') return;
  const paths = await getLinkedPathsForAccount(account.id, await getAccountBindingIds(account.id));
  const bundledTapd = readBundledCliVersions().tapd;
  for (const path of paths) {
    const health: SyncHealth = await readShownSyncHealth(path);
    if (health.state === 'notSynced' || health.state === 'starting') continue;
    const tapd = health.state === 'running' ? await readTapdStatus(path) : null;
    const key = spaceKey(path);
    if (tapd?.offline) {
      if (!offlineSince.has(key)) offlineSince.set(key, now);
    } else {
      offlineSince.delete(key);
    }
    const problems = syncProblemsFrom({
      health,
      tapd,
      offlineSince: offlineSince.get(key) ?? null,
      now,
    });
    for (const problem of problems) {
      telemetryService.trackSyncProblem(key, {
        ...problem,
        tapd_version: scrubVersion(tapd?.version) ?? scrubVersion(bundledTapd),
      });
    }
  }
}

export function startSyncProblemWatch(): void {
  const run = () => {
    void checkSyncProblems().catch((error: unknown) => {
      log.warn('rig: sync problem check failed', { error: String(error) });
    });
  };
  setTimeout(run, FIRST_CHECK_MS).unref?.();
  setInterval(run, CHECK_EVERY_MS).unref?.();
}
