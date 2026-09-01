import type { RigCommentPermissionDetail } from '@shared/rig/comments';

/**
 * Turns a headless comment-agent's permission request into text a
 * non-technical reader can act on without parsing shell syntax, a JSON blob,
 * or an absolute path — the headline the comment-permissions card
 * (`comments-margin.tsx`'s `PermissionRequestRow`) leads with, plus a short
 * secondary line for the kinds where one more fact (a diff size, the file's
 * real location) earns its place beside the headline. The exact command,
 * path, or URL stays available in full behind that card's own "Show details"
 * disclosure — nothing here decides what is *safe* to run, only what is
 * *readable*; every request still goes through the same Allow/Reject choice.
 *
 * Pure and provider-agnostic: no filesystem access, no knowledge of any one
 * ACP provider's quirks beyond the `$RIG_CLI_PATH` sentinel this app's own
 * hidden-context prompt hands the model (`comment-agent-prompt.ts`) — naming
 * that one exactly the way `comment-agent-auto-approve.ts`'s `isRigCliToken`
 * already does, so the same command reads as "rig" wherever it turns up.
 */

export type PermissionSummary = {
  headline: string;
  secondary?: string;
};

/** The exact `$RIG_CLI_PATH` token forms the hidden-context prompt hands the model, quoted or not. */
const RIG_CLI_TOKENS = new Set(['$RIG_CLI_PATH', '"$RIG_CLI_PATH"']);

/**
 * Shell keywords that lead a compound command (`for f in …; do …; done`).
 * Naming one of these as "the command" would mislead rather than inform —
 * better to fall back to the generic phrasing than to say "Wants to run for".
 */
const SHELL_KEYWORDS = new Set(['for', 'if', 'while', 'until', 'case', 'function', 'do', 'then', 'else']);

/**
 * Characters that mean the first whitespace-delimited token isn't a bare
 * executable reference: chaining/substitution metacharacters, or a subshell.
 * Deliberately blunt rather than a real shell parser — a command this
 * rejects still falls back to the safe generic headline.
 */
const NOT_A_BARE_TOKEN = /[$`<>|&;(){}\n\r]/;

/**
 * A token that looks like an opaque encoded blob rather than a program name —
 * e.g. the long base64url target ref this app's own hidden-context commands
 * carry (`comment-agent-auto-approve.test.ts`'s `TARGET_REF`), on the chance
 * one ever lands as the first token instead of an argument. Ordinary program
 * names don't run this long without a `.`/`/`, so the false-positive risk is
 * low and the failure mode (falling back to the generic headline) is safe.
 */
const LOOKS_OPAQUE = /^[A-Za-z0-9+/_-]{24,}=*$/;

function unquote(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' || first === "'") && first === last) return token.slice(1, -1);
  }
  return token;
}

/** Last path segment, tolerant of both `/` and `\` separators. */
function basenameOf(token: string): string {
  const segments = token.split(/[/\\]/);
  return segments[segments.length - 1] || token;
}

/**
 * The command's first token, named the way a reader would recognize it — or
 * null when the command doesn't parse cleanly enough to name safely (a
 * compound shell construct, an env-var assignment prefix, an unresolvable
 * variable, or a token that looks like an opaque encoded argument). Never
 * looks past the first token, so nothing later in the command — a `--target`
 * argument carrying a long encoded ref, say — can end up in the result.
 */
function commandSubject(command: string): string | null {
  const trimmed = command.trim();
  if (trimmed.length === 0) return null;
  const rawFirst = trimmed.split(/\s+/, 1)[0];
  if (!rawFirst) return null;
  if (RIG_CLI_TOKENS.has(rawFirst)) return 'rig';
  if (NOT_A_BARE_TOKEN.test(rawFirst) || rawFirst.includes('=')) return null;
  const unquoted = unquote(rawFirst);
  if (SHELL_KEYWORDS.has(unquoted)) return null;
  const name = basenameOf(unquoted);
  if (!name || LOOKS_OPAQUE.test(name)) return null;
  return name;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * `path`, rendered workspace-relative when it resolves under `workspaceRoot`.
 * A path that isn't absolute is assumed already workspace-relative (some
 * providers report it that way) rather than guessed at further. Never
 * fabricates a relative path for something outside the root — that case is
 * reported via `insideWorkspace: false` instead, for the caller to phrase.
 */
function displayPath(
  path: string,
  workspaceRoot: string | null | undefined
): { text: string; insideWorkspace: boolean } {
  if (!isAbsolutePath(path)) return { text: path, insideWorkspace: true };
  if (workspaceRoot) {
    const root = workspaceRoot.replace(/[\\/]+$/, '');
    if (path === root) return { text: '.', insideWorkspace: true };
    if (path.startsWith(`${root}/`) || path.startsWith(`${root}\\`)) {
      return { text: path.slice(root.length + 1), insideWorkspace: true };
    }
  }
  return { text: path, insideWorkspace: false };
}

function urlHost(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/**
 * The card's headline sentence (plus an optional secondary line), from a
 * permission request's typed detail. `workspaceRoot` is the headless turn's
 * cwd (`RigCommentPermissionUpdate.workspaceRoot`), used only to decide
 * whether an edit/read's path is inside the workspace and, if so, to shorten
 * it — never required, since a request predating this app's rollout of that
 * field, or one whose root couldn't be resolved, still needs a headline.
 */
export function summarizePermissionDetail(
  detail: RigCommentPermissionDetail | undefined,
  workspaceRoot?: string | null
): PermissionSummary {
  switch (detail?.kind) {
    case 'execute': {
      if (!detail.command) return { headline: 'Wants to run a command in this workspace' };
      const subject = commandSubject(detail.command);
      return { headline: subject ? `Wants to run ${subject}` : 'Wants to run a command in this workspace' };
    }
    case 'edit': {
      const deleting = detail.summary === 'delete file';
      if (!detail.path) return { headline: deleting ? 'Wants to delete a file' : 'Wants to edit a file' };
      const { text } = displayPath(detail.path, workspaceRoot);
      if (deleting) return { headline: `Wants to delete ${text}` };
      return { headline: `Wants to edit ${text}`, ...(detail.summary ? { secondary: detail.summary } : {}) };
    }
    case 'read': {
      if (!detail.path) return { headline: 'Wants to read a file' };
      const { text, insideWorkspace } = displayPath(detail.path, workspaceRoot);
      return insideWorkspace
        ? { headline: `Wants to read ${text}` }
        : { headline: 'Wants to read a file outside this workspace', secondary: text };
    }
    case 'fetch': {
      if (!detail.url) return { headline: 'Wants to fetch a web page' };
      const host = urlHost(detail.url);
      return {
        headline: host ? `Wants to fetch ${host}` : 'Wants to fetch a web page',
        secondary: detail.url,
      };
    }
    default:
      return { headline: detail?.name ? `Wants to use ${detail.name}` : 'Wants to use this tool' };
  }
}

/**
 * The exact command/path/URL a request's detail carries, verbatim — what the
 * card's "Show details" disclosure renders in monospace. Never summarized or
 * truncated here; that's the point of keeping it behind a fold instead of
 * baking it into the headline.
 */
export function rawPermissionDetailText(detail: RigCommentPermissionDetail | undefined): string | null {
  switch (detail?.kind) {
    case 'execute':
      return detail.command ?? null;
    case 'edit':
    case 'read':
      if (!detail.path) return null;
      return detail.summary ? `${detail.path}  ${detail.summary}` : detail.path;
    case 'fetch':
      return detail.url ?? null;
    default:
      return detail?.name ?? null;
  }
}

/**
 * Sober, explicit replacement for whatever label the session gave an
 * `allow_always` option (Claude's own is "Always Allow all Bash" / "Always
 * Allow all Write" — accurate but stated from the tool's point of view, not
 * the reader's). Scoped by detail kind rather than the provider's wording, so
 * it reads the same regardless of which agent is asking.
 */
export function alwaysAllowLabel(detail: RigCommentPermissionDetail | undefined): string {
  switch (detail?.kind) {
    case 'execute':
      return 'Always allow — applies to all commands this agent runs, beyond this thread';
    case 'edit':
      return 'Always allow — applies to all edits this agent makes, beyond this thread';
    case 'read':
      return 'Always allow — applies to all files this agent reads, beyond this thread';
    case 'fetch':
      return 'Always allow — applies to all pages this agent fetches, beyond this thread';
    default:
      return 'Always allow — applies to everything this agent does, beyond this thread';
  }
}
