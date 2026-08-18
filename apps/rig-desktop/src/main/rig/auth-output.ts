/**
 * Pure parsing of `rig login`'s piped output. Kept separate from the spawn
 * plumbing in `auth.ts` so it can be tested without a child process.
 */

/**
 * What the CLI prints today (non-interactive branch of `loginCommand`):
 *
 *   Open this URL to log in:
 *   https://<hub>/auth/device?callback=http%3A%2F%2Flocalhost%3A<port>%2Fcallback
 *
 *   Waiting for sign-in...
 */
const DEVICE_AUTH_URL = /https?:\/\/[^\s'"<>]*\/auth\/device[^\s'"<>]*/i;
const ANY_HTTP_URL = /https?:\/\/[^\s'"<>]+/gi;
const LOOPBACK_HOST = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i;

/** Sentence punctuation a URL at the end of a line may pick up. */
function trimTrailing(url: string): string {
  return url.replace(/[.,;:!?)\]}]+$/, '');
}

/**
 * The sign-in URL to open in the browser, or null if the output does not carry
 * one yet.
 *
 * Deliberately tolerant of the surrounding copy — only the URL shape is matched,
 * so re-wording the CLI's prompts cannot break sign-in. The fallback skips
 * loopback URLs: the CLI's own callback server address is embedded in the auth
 * URL's query string and must never be what we open.
 */
export function extractRigAuthUrl(output: string): string | null {
  const device = DEVICE_AUTH_URL.exec(output);
  if (device) return trimTrailing(device[0]);

  for (const match of output.matchAll(ANY_HTTP_URL)) {
    const url = trimTrailing(match[0]);
    if (!LOOPBACK_HOST.test(url)) return url;
  }
  return null;
}

/**
 * A one-line reason for a failed `rig` command, drawn from the last non-empty
 * line the CLI printed. Falls back to the exit code when it printed nothing.
 */
export function commandFailureMessage(command: string, output: string, code: number | null): string {
  const lastLine = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
  if (lastLine) return lastLine;
  return code === null
    ? `rig ${command} stopped unexpectedly.`
    : `rig ${command} exited with code ${code}.`;
}

export function loginFailureMessage(output: string, code: number | null): string {
  return commandFailureMessage('login', output, code);
}

export function logoutFailureMessage(output: string, code: number | null): string {
  return commandFailureMessage('logout', output, code);
}
