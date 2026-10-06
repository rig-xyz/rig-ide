import { basename } from 'node:path';
import { app } from 'electron';
import { appService } from '@main/core/app/service';
import { getDiagnosticLogAttachment } from '@main/lib/file-logger';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import type {
  ProblemReportPayload,
  ProblemReportSaveResult,
  ProblemReportSendResult,
  ProblemReportSpace,
} from '@shared/rig/problem-report';
import { fetchWorkspaceBindings, getCurrentAccountId, isError, resolveContext } from './account';
import { agentCliFacts } from './agent-run-failure-instance';
import { findBindingConfig } from './binding';
import { readBundledCliVersions } from './bundled-cli';
import { buildProblemReport } from './problem-report';
import { getLinkedPathsForAccount } from './recent-rigs';
import { fetchRelay, recentRelayFailures, rigClientHeaders } from './relay-request';
import { getAccountBindingIds, readShownSyncHealth } from './sync-health';
import { readTapdStatus } from './sync-problems-instance';

/**
 * Help › Report a Problem, the main-process side: gathers the bundle
 * (`problem-report.ts` builds and caps it), sends it to the relay with the
 * account's token, or saves it to a file the person picks.
 */

const SEND_TIMEOUT_MS = 30_000;
/** How many spaces' sync processes are asked at once. */
const STATUS_CONCURRENCY = 4;

async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Each of this account's rigs and spaces on this computer: its name, sync state and last sync error. */
async function gatherSpaces(): Promise<ProblemReportSpace[]> {
  const account = await getCurrentAccountId();
  if (account.status !== 'known') return [];
  const [paths, bindings] = await Promise.all([
    getAccountBindingIds(account.id).then((ids) => getLinkedPathsForAccount(account.id, ids)),
    fetchWorkspaceBindings(),
  ]);
  const names = new Map(bindings.success ? bindings.data.map((b) => [b.id, b.name] as const) : []);
  return mapLimited(paths.slice(0, 50), STATUS_CONCURRENCY, async (path) => {
    const bindingId = findBindingConfig(path)?.config.bindingId;
    const name = (bindingId && names.get(bindingId)) || basename(path);
    const health = await readShownSyncHealth(path);
    if (health.state !== 'running') {
      return {
        name,
        state: health.state,
        ...(health.state === 'error' ? { lastError: health.message } : {}),
      };
    }
    const tapd = await readTapdStatus(path);
    const applyError = tapd?.lastApplyError;
    const state = !tapd
      ? 'running'
      : tapd.offline
        ? 'offline'
        : (tapd.conflicts?.length ?? 0) > 0
          ? 'conflicts'
          : (tapd.pendingApplies ?? 0) + (tapd.pendingUploads ?? 0) > 0
            ? 'catching_up'
            : 'running';
    return {
      name,
      state,
      ...(applyError
        ? { lastError: `${applyError.op ?? 'apply'} failed: ${applyError.reason ?? 'unknown'}` }
        : {}),
    };
  });
}

export async function gatherProblemReport(text: string): Promise<ProblemReportPayload> {
  const bundled = readBundledCliVersions();
  const claude = agentCliFacts('claude');
  const codex = agentCliFacts('codex');
  const [spaces, attachment] = await Promise.all([
    gatherSpaces().catch((error: unknown) => {
      log.warn('Problem report: could not read the sync state of your spaces', {
        error: String(error),
      });
      return [];
    }),
    getDiagnosticLogAttachment(),
  ]);
  return buildProblemReport({
    text,
    appVersion: app.getVersion(),
    os: rigClientHeaders()['x-rig-os'] ?? process.platform,
    versions: {
      rig: bundled.rig,
      tapd: bundled.tapd,
      claude: claude.version,
      codex: codex.version,
      codexSource: codex.source,
    },
    spaces,
    failedRequests: recentRelayFailures(),
    log: attachment.content,
  });
}

export async function sendProblemReport(text: string): Promise<ProblemReportSendResult> {
  const ctx = await resolveContext();
  if (isError(ctx))
    return ctx.kind === 'notSignedIn'
      ? { kind: 'signedOut' }
      : { kind: 'failed', message: ctx.message };
  const payload = await gatherProblemReport(text);
  let response: Response;
  try {
    response = await fetchRelay(`${ctx.url.replace(/\/+$/, '')}/v1/me/problem-reports`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ctx.token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (error) {
    log.warn('Problem report: could not reach the relay', { error: String(error) });
    return { kind: 'failed', message: "Rig couldn't reach the server." };
  }
  if (response.status === 404) {
    return { kind: 'failed', message: "The server can't take reports yet." };
  }
  if (!response.ok) {
    log.warn('Problem report: the relay refused it', { status: response.status });
    return { kind: 'failed', message: `The server couldn't take it (${response.status}).` };
  }
  try {
    const body = (await response.json()) as { ref?: unknown };
    if (typeof body.ref === 'string' && body.ref) {
      log.info('Problem report sent', { ref: body.ref });
      return { kind: 'sent', ref: body.ref };
    }
  } catch {
    // falls through
  }
  return { kind: 'failed', message: "The server didn't send back a reference." };
}

export async function saveProblemReport(text: string): Promise<ProblemReportSaveResult> {
  try {
    const payload = await gatherProblemReport(text);
    const stamp = new Date().toISOString().slice(0, 10);
    const path = await appService.saveTextFile({
      title: 'Save problem report',
      defaultPath: `rig-problem-report-${stamp}.json`,
      content: `${JSON.stringify(payload, null, 2)}\n`,
    });
    return path ? { kind: 'saved' } : { kind: 'cancelled' };
  } catch (error) {
    log.warn('Problem report: could not save it', { error: String(error) });
    return { kind: 'failed', message: "Couldn't save the file." };
  }
}

export const rigProblemReportController = createRPCController({
  /** Whether Send can work: signed in to a relay the app trusts. */
  status: async (): Promise<{ signedIn: boolean }> => ({
    signedIn: !isError(await resolveContext()),
  }),
  send: ({ text }: { text: string }) => sendProblemReport(text),
  saveToFile: ({ text }: { text: string }) => saveProblemReport(text),
});
