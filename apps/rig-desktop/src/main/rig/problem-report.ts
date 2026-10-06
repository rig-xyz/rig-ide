import { redactAll, redactSecrets } from '@emdash/shared/logger';
import { trimToLineBoundary } from '@emdash/shared/logger/transport';
import { scrubErrorMessage } from '@main/lib/telemetry-scrub';
import type { ProblemReportPayload, ProblemReportSpace } from '@shared/rig/problem-report';
import type { RelayFailure } from './relay-request';

/**
 * Help › Report a Problem: the bundle sent to `POST /v1/me/problem-reports`
 * (or saved to a file). Pure, so its caps and scrubbing are unit-tested
 * (`problem-report.test.ts`). It never holds file contents, messages or
 * prompts: the person's own words, versions, sync states, and the app log
 * with secrets removed.
 */

/** The tail of the app log that goes along. */
export const REPORT_LOG_BYTES = 400 * 1024;
export const MAX_REPORT_TEXT_CHARS = 5_000;
export const MAX_REPORT_SPACES = 50;
const MAX_SPACE_NAME_CHARS = 100;
const MAX_FAILED_REQUESTS = 20;

function short(value: string | null | undefined, max = 60): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

export function buildProblemReport(input: {
  text: string;
  appVersion: string;
  os: string;
  versions: {
    rig: string | null;
    tapd: string | null;
    claude: string | null;
    codex: string | null;
    codexSource: string | null;
  };
  spaces: ProblemReportSpace[];
  failedRequests: RelayFailure[];
  log: string;
}): ProblemReportPayload {
  const spaces = input.spaces.slice(0, MAX_REPORT_SPACES).map((space) => {
    const lastError = space.lastError ? scrubErrorMessage(space.lastError) : '';
    return {
      name: redactSecrets(space.name).slice(0, MAX_SPACE_NAME_CHARS),
      state: short(space.state, 40) ?? 'unknown',
      ...(lastError ? { lastError } : {}),
    };
  });
  return {
    // The person's own words go as written, minus anything that looks like a secret.
    text: redactSecrets(input.text.trim()).slice(0, MAX_REPORT_TEXT_CHARS),
    appVersion: short(input.appVersion) ?? 'unknown',
    os: short(input.os, 80) ?? 'unknown',
    context: {
      rig: short(input.versions.rig),
      tapd: short(input.versions.tapd),
      claude: short(input.versions.claude),
      codex: short(input.versions.codex),
      codexSource: short(input.versions.codexSource, 20),
      spaces,
      failedRequests: input.failedRequests.slice(-MAX_FAILED_REQUESTS).map((failure) => ({
        reqId: failure.reqId,
        status: failure.status,
        method: failure.method,
        route: failure.route,
        at: new Date(failure.at).toISOString(),
      })),
    },
    // Already redacted by the log's own writer; redacted again here (before the cut, so the cap holds).
    log: trimToLineBoundary(redactAll(input.log), REPORT_LOG_BYTES),
  };
}
