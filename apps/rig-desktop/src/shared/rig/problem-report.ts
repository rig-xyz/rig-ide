/**
 * Help › Report a Problem. The bundle the app sends to the relay
 * (`POST /v1/me/problem-reports`) or saves to a file; the relay ties it to
 * the signed-in account and answers with a short reference (`RPT-…`).
 */

export type ProblemReportSpace = {
  name: string;
  /** The space's sync state on this computer (`running`, `stopped`, `paused`, `offline`, `conflicts`, …). */
  state: string;
  /** The last sync error, scrubbed: paths cut to file names, secrets removed. */
  lastError?: string;
};

export type ProblemReportFailedRequest = {
  /** The relay's `x-request-id`, when it gave one. */
  reqId: string | null;
  status: number | null;
  method: string;
  /** The path with ids replaced by `:id`. */
  route: string;
  at: string;
};

export type ProblemReportPayload = {
  text: string;
  appVersion: string;
  os: string;
  context: {
    rig: string | null;
    tapd: string | null;
    claude: string | null;
    codex: string | null;
    codexSource: string | null;
    spaces: ProblemReportSpace[];
    /** Relay calls that failed recently, so a report lines up with the relay's own log. */
    failedRequests: ProblemReportFailedRequest[];
  };
  /** The tail of the app log (about 400 KB), secrets removed. */
  log: string;
};

export type ProblemReportSendResult =
  | { kind: 'sent'; ref: string }
  | { kind: 'signedOut' }
  /** Offline, the relay refused it, or a relay too old to take reports: the dialog offers Save to a file. */
  | { kind: 'failed'; message: string };

export type ProblemReportSaveResult =
  | { kind: 'saved' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string };
