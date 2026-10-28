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

/**
 * Whether a read's words stay a read on github.com: no `--web` (it opens a
 * browser), and `--repo`/`-R` only as OWNER/REPO, so a read can't be pointed
 * at another host (which would carry what's in the command there). A PR or
 * issue given by its URL must be a github.com one.
 */
function staysOnGitHub(words: string[]): boolean {
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w === '--web' || w === '-w' || w.startsWith('--web=')) return false;
    if (w === '--repo' || w === '-R') {
      if (!PLAIN_REPO.test(words[i + 1] ?? '')) return false;
      i++;
    } else if (w.startsWith('--repo=') || (w.startsWith('-R') && w.length > 2)) {
      if (!PLAIN_REPO.test(w.startsWith('--repo=') ? w.slice('--repo='.length) : w.slice(2))) return false;
    } else if (w.includes('://') && !w.startsWith('https://github.com/')) return false;
  }
  return true;
}

/** A `gh` read as its arguments (no shell ever sees it), or null when it isn't one of `GH_READ` or would leave github.com. */
export function ghReadArgs(command: string): string[] | null {
  const text = command.trim();
  if (!GH_READ.test(text)) return null;
  const jq = / --jq '([^'\n]*)'$/.exec(text);
  const head = jq ? text.slice(0, jq.index) : text;
  // Words, with a double-quoted value kept whole (--search "is:open review-requested:@me").
  const words = [...head.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!);
  if (!staysOnGitHub(words)) return null;
  return [...words.slice(1), ...(jq ? ['--jq', jq[1]!] : [])];
}

const MAX_OUTPUT = 20_000;

/**
 * Runs one `gh` read for the background orchestrator (`rig_github`), which
 * has no Bash: the command is checked against `GH_READ` and run as `gh` with
 * those arguments, never through a shell.
 */
export function runGhRead(command: string, timeoutMs = 30_000): Promise<Result<string, { message: string }>> {
  const args = ghReadArgs(command);
  if (!args) return Promise.resolve(err({ message: 'Only gh read commands: gh pr view/list/status/checks/diff, gh issue view/list/status, gh search prs/issues, gh run view/list, gh repo view, with an optional trailing --jq filter. No --web, and --repo only as owner/repo.' }));
  return new Promise((resolve) => {
    execFile('gh', args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } }, (error, stdout, stderr) => {
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
    const child = execFile('gh', args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } }, (error, stdout, stderr) => {
      if (error) return resolve(err({ message: (String(stderr).trim() || error.message).slice(0, 600) }));
      resolve(ok(String(stdout)));
    });
    child.stdin?.end(stdin);
  });
}
