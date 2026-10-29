import { execFile } from 'node:child_process';
import { err, ok, type Result } from '@emdash/shared';

/**
 * GitHub's read-only commands, with no way to chain another: claude.ai has no
 * GitHub connector, and a PR's state is what a check most often needs.
 * A trailing `--jq '…'` filter is allowed: inside single quotes the shell
 * interprets nothing but the closing quote.
 */
export const GH_READ = /^gh (pr (view|list|status|checks|diff)|issue (view|list|status)|search (prs|issues)|run (view|list)|repo view)( [^;&|<>`$\\\n']*)?( --jq '[^'\n]*')?$/;

/** A repository as `--repo` may name it: OWNER/REPO on github.com, never HOST/OWNER/REPO or a URL. */
const PLAIN_REPO = /^[\w.-]+\/[\w.-]+$/;
/** A link gh may follow: on github.com, nothing but a path. */
const GITHUB_URL = /^https:\/\/github\.com\/[\w.\-/#]+$/;
const NUMBER = /^\d+$/;

const isNumber = (w: string) => NUMBER.test(w);
const isUrl = (w: string) => GITHUB_URL.test(w);
/** A PR by number, link or branch: a branch never has `@` or `:` (`git@host:o/r`, `owner:branch`). */
const isPr = (w: string) => isNumber(w) || isUrl(w) || /^[\w.\-/]+$/.test(w);
const isIssue = (w: string) => isNumber(w) || isUrl(w);
const isRepo = (w: string) => PLAIN_REPO.test(w) || isUrl(w);
/** A search's words: plain ones, or `qualifier:value` (review-requested:@me, repo:o/r). */
const isQuery = (w: string) =>
  w.split(/\s+/).every((t) => t === '' || /^[\w.\-/#*]+$/.test(t) || (/^[\w-]+:[^\s:]+$/.test(t) && !t.includes('//')));
const NONE = () => false;

/** A flag takes a value (`--flag v` or `--flag=v`), or stands alone. */
type Flags = Record<string, 'value' | 'bool'>;
const LIST: Flags = { '--assignee': 'value', '--author': 'value', '--label': 'value', '--limit': 'value', '--search': 'value', '--state': 'value', '--app': 'value' };
const SEARCH: Flags = {
  ...LIST,
  '--owner': 'value', '--review-requested': 'value', '--reviewed-by': 'value', '--involves': 'value', '--mentions': 'value',
  '--commenter': 'value', '--sort': 'value', '--order': 'value', '--updated': 'value', '--created': 'value', '--closed': 'value',
  '--merged': 'value', '--base': 'value', '--head': 'value', '--checks': 'value', '--review': 'value', '--milestone': 'value',
  '--language': 'value', '--match': 'value', '--team-review-requested': 'value', '--visibility': 'value', '--draft': 'bool',
  '--archived': 'bool', '--include-prs': 'bool',
};

/**
 * Each read and what it takes: its own long flags (plus `--repo` and `--json`), and
 * which words may stand on their own. Nothing else: no `--web`, `--template`, `--jq`
 * but the trailing one, and no clustered short flags (`-cq…` carries a jq filter).
 */
const READS: Record<string, { flags: Flags; arg: (w: string) => boolean }> = {
  'pr view': { flags: { '--comments': 'bool' }, arg: isPr },
  'pr list': { flags: { ...LIST, '--base': 'value', '--head': 'value', '--draft': 'bool' }, arg: NONE },
  'pr status': { flags: { '--conflict-status': 'bool' }, arg: NONE },
  'pr checks': { flags: { '--required': 'bool' }, arg: isPr },
  'pr diff': { flags: { '--name-only': 'bool', '--patch': 'bool', '--color': 'value' }, arg: isPr },
  'issue view': { flags: { '--comments': 'bool' }, arg: isIssue },
  'issue list': { flags: { ...LIST, '--mention': 'value', '--milestone': 'value' }, arg: NONE },
  'issue status': { flags: {}, arg: NONE },
  'search prs': { flags: SEARCH, arg: isQuery },
  'search issues': { flags: SEARCH, arg: isQuery },
  'run view': { flags: { '--job': 'value', '--attempt': 'value', '--log': 'bool', '--log-failed': 'bool', '--verbose': 'bool', '--exit-status': 'bool' }, arg: isNumber },
  'run list': { flags: { '--branch': 'value', '--commit': 'value', '--event': 'value', '--limit': 'value', '--status': 'value', '--user': 'value', '--workflow': 'value', '--created': 'value', '--all': 'bool' }, arg: NONE },
  'repo view': { flags: { '--branch': 'value' }, arg: isRepo },
};
const EVERY_READ: Flags = { '--repo': 'value', '--json': 'value' };
/** The short flags allowed, each alone, as their long one: `-R` also as `-R<owner/repo>`. */
const SHORT: Record<string, string> = { '-R': '--repo', '-L': '--limit', '-s': '--state', '-S': '--search' };

/** A flag's value: `--repo` only as OWNER/REPO, `--json` only field names, nothing a flag or a link. */
function valueOk(flag: string, value: string | undefined): boolean {
  if (value === undefined || value === '' || value.startsWith('-') || value.includes('://')) return false;
  if (flag === '--repo') return PLAIN_REPO.test(value);
  if (flag === '--json') return /^[\w,]+$/.test(value);
  if (flag === '--limit') return NUMBER.test(value);
  return true;
}

/**
 * Whether a read's words are only what `READS` allows it, so it stays a read on
 * github.com: no host but github.com (`--repo` as OWNER/REPO, links on github.com,
 * no `git@host:…`), no browser, and no filter but the trailing `--jq '…'`, which
 * `jqStaysOnInput` checks.
 */
function onlyAllowed(words: string[]): boolean {
  const read = READS[`${words[1]} ${words[2]}`];
  if (words[0] !== 'gh' || !read) return false;
  const flags: Flags = { ...EVERY_READ, ...read.flags };
  for (let i = 3; i < words.length; i++) {
    let w = words[i]!;
    if (!w.startsWith('-')) {
      if (!read.arg(w)) return false;
      continue;
    }
    if (/^-R[^-]/.test(w)) {
      if (!PLAIN_REPO.test(w.slice(2))) return false;
      continue;
    }
    if (/^-[^-]/.test(w)) {
      if (!SHORT[w]) return false;
      w = SHORT[w]!;
    }
    const eq = w.indexOf('=');
    const flag = eq === -1 ? w : w.slice(0, eq);
    const kind = flags[flag];
    if (!kind) return false;
    if (kind === 'bool') {
      if (eq !== -1) return false;
      continue;
    }
    if (!valueOk(flag, eq === -1 ? words[++i] : w.slice(eq + 1))) return false;
  }
  return true;
}

/**
 * Whether a jq filter reads only the JSON gh hands it: never the environment
 * (`$ENV`, `env`) or anything else jq can reach (`input`, `inputs`,
 * `input_filename`, `$__loc__`). A field or a string named env is fine.
 */
export function jqStaysOnInput(filter: string): boolean {
  return !/\$\s*(ENV\b|__)|(?<![\w.$"])(env|inputs?|input_filename)(?![\w"])/.test(filter);
}

/** A `gh` read as its arguments (no shell ever sees it), or null when it isn't one of `GH_READ` or would leave github.com. */
export function ghReadArgs(command: string): string[] | null {
  const text = command.trim();
  if (!GH_READ.test(text)) return null;
  const jq = / --jq '([^'\n]*)'$/.exec(text);
  if (jq && !jqStaysOnInput(jq[1]!)) return null;
  const head = jq ? text.slice(0, jq.index) : text;
  // Words, with a double-quoted value kept whole (--search "is:open review-requested:@me").
  const words = [...head.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!);
  if (!onlyAllowed(words)) return null;
  return [...words.slice(1), ...(jq ? ['--jq', jq[1]!] : [])];
}

/**
 * What of the app's environment `gh` gets: what it needs to find itself, its
 * config and its github.com sign-in (a token, or the keychain through HOME).
 * Nothing for another host (GH_HOST, GH_ENTERPRISE_*), no proxy (they can
 * carry a password), and none of the rest of the main process's environment.
 */
const GH_ENV = /^(PATH|HOME|USER|LOGNAME|TMPDIR|LANG|LC_\w+|GH_TOKEN|GITHUB_TOKEN|GH_CONFIG_DIR|XDG_(CONFIG|STATE|DATA|CACHE)_HOME|SSL_CERT_(FILE|DIR))$/;

export function ghEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) if (GH_ENV.test(key) && value !== undefined) out[key] = value;
  return { ...out, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' };
}

const MAX_OUTPUT = 20_000;

/**
 * Runs one `gh` read for the background orchestrator (`rig_github`), which
 * has no Bash: the command is checked against `GH_READ` and run as `gh` with
 * those arguments, never through a shell.
 */
export function runGhRead(command: string, timeoutMs = 30_000): Promise<Result<string, { message: string }>> {
  const args = ghReadArgs(command);
  if (!args) return Promise.resolve(err({ message: 'Only gh read commands: gh pr view/list/status/checks/diff, gh issue view/list/status, gh search prs/issues, gh run view/list, gh repo view, with their usual long flags (-R, -L, -s, -S alone), and an optional trailing --jq filter that reads only its input. No --web or --template, --repo only as owner/repo, and links only on github.com.' }));
  return new Promise((resolve) => {
    execFile('gh', args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: ghEnv() }, (error, stdout, stderr) => {
      if (error) return resolve(err({ message: (String(stderr).trim() || error.message).slice(0, 600) }));
      const out = String(stdout);
      resolve(ok(out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}\n… (cut at ${MAX_OUTPUT} characters)` : out));
    });
  });
}

/**
 * One `gh` write for a card's Post (orch/send.ts): the person clicked it, and
 * the words go on stdin, never through a shell or the command line.
 */
export function runGhWrite(args: string[], stdin: string, timeoutMs = 30_000): Promise<Result<string, { message: string }>> {
  return new Promise((resolve) => {
    const child = execFile('gh', args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, env: ghEnv() }, (error, stdout, stderr) => {
      if (error) return resolve(err({ message: (String(stderr).trim() || error.message).slice(0, 600) }));
      resolve(ok(String(stdout)));
    });
    child.stdin?.end(stdin);
  });
}
