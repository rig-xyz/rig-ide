import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { err, ok, type Result } from '@emdash/shared';
import { RIG_TOOLS_SERVER } from '@shared/spaces/connectors';
import type { SpacesAcpSessions } from '../spaces/dispatch';

/**
 * How Rig runs a Claude session of its own that reads what other people
 * wrote (Slack, Linear, GitHub, the Feed): the orchestrator, a source run, a
 * check, Home's chat and a card's Send. Text in what it reads can ask Claude
 * to do things, so the person's own Claude settings must never widen what
 * such a session can do, whatever their allow rules, hooks or default mode say.
 *
 * - The built-in tools that act or reach out (shell, file writes, the web,
 *   subagents) are denied outright: deny rules beat any allow rule.
 * - Starting work (rig_start) is denied too, unless the session is one the
 *   person talks to (Home's chat), where rig_start checks their turn.
 * - The guard (`toolGuard`): a PreToolUse command hook, in the session's own
 *   settings, that denies every call the session's policy doesn't permit:
 *   reads (`isReadTool`) and the session's own allowlist, or for a Send its
 *   one message. A hook's deny beats any allow rule, and any other hook's
 *   allow, so this holds whatever the person's settings say.
 * - The policy tier (`appPermissionsOnly`): their settings files can't allow
 *   a call, and there's no bypass mode, so every call the guard lets through
 *   still comes to the session's own permission handler. An IT-managed tier
 *   on the Mac drops it, which is why the guard comes first; one that also
 *   turns hooks off without locking allow rules leaves neither, and then the
 *   session doesn't run (`lockdownHolds`).
 * - It runs in Ask first (`askFirst`), whatever their default mode.
 */

/** Built-in tools no locked session can use. */
export const LOCKED_DENIED_TOOLS = ['Bash', 'BashOutput', 'KillShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent'];

export const RIG_START_TOOL = `mcp__${RIG_TOOLS_SERVER}__rig_start`;

/** The built-in tools a locked session may use: reading files, finding Rig's tools, its own todo list. */
export const BUILT_IN_READS = ['Read', 'Glob', 'Grep', 'LS', 'ToolSearch', 'TodoWrite', 'ListMcpResourcesTool', 'ReadMcpResourceTool'];

/** A Rig tool by its full name, as the guard sees it. */
export const rigTool = (name: string) => `mcp__${RIG_TOOLS_SERVER}__${name}`;

/** Claude Code's "Ask first": every call the deny rules don't settle comes to the permission handler. */
export const LOCKED_MODE = 'default';

/**
 * What a locked session may call, as the guard checks it. Anything else is
 * denied.
 */
export type GuardPolicy = {
  /** Exact tool names it may call besides reads (its Rig tools, the built-in reads). */
  allow: string[];
  /** The MCP servers whose read tools it may call (a regex on the server name), or null for none. */
  readServers: string | null;
  /** A Send: the one Slack message it may send, word for word, once (`once` is a file the guard claims). */
  send?: { channel: string; thread: string | null; text: string; once: string };
};

/** The start-session options that lock a session down (the dispatch adapter's `startSession`), with its guard. */
export function lockedSession(opts: { rigStart?: boolean; policy?: Partial<GuardPolicy> } = {}) {
  const policy: GuardPolicy = {
    allow: [...BUILT_IN_READS, ...(opts.policy?.allow ?? [])],
    readServers: opts.policy?.readServers === undefined ? CLAUDE_AI_SERVERS : opts.policy.readServers,
    ...(opts.policy?.send ? { send: opts.policy.send } : {}),
  };
  return {
    disallowedTools: [...LOCKED_DENIED_TOOLS, ...(opts.rigStart ? [] : [RIG_START_TOOL])],
    noBypassPermissions: true,
    appPermissionsOnly: true,
    toolGuardCommand: guardCommand(policy),
  };
}

/** The person's claude.ai connectors, as Claude Code names their servers. */
export const CLAUDE_AI_SERVERS = '^claude_ai_';

/**
 * Whether a connector tool (its name after `mcp__<server>__`) only reads: a
 * read verb is one of its words (snake_case, kebab-case or camelCase), and
 * none of its words writes. A word that is a noun as often as a verb (link,
 * run, post, draft, comment) writes only as the first or second word, where
 * the verb goes: `link-view-resources` writes, `getIssueLinkTypes` reads.
 * `google_drive_search`, `lookupJiraAccountId` and `getConfluenceCommentChildren`
 * read; `get_or_create_label`, `mark_read` and `addCommentToJiraIssue` don't.
 * A name with no read verb is refused.
 *
 * Self-contained (no outer names): the guard runs it from its own source.
 */
export function isReadTool(name: string): boolean {
  const reads = [
    'list', 'get', 'search', 'read', 'fetch', 'query', 'find', 'view', 'lookup', 'download', 'describe', 'check',
    'preview', 'match', 'extract', 'suggest', 'whoami', 'info', 'load', 'count', 'retrieve', 'browse', 'inspect',
  ];
  // Verbs that make a tool more than a read when they come with a read verb: `get_or_create`, `mark_read`, `read_and_delete`.
  const writes = [
    'add', 'apply', 'approve', 'archive', 'assign', 'attach', 'cancel', 'clone', 'close', 'copy', 'create', 'delete',
    'detach', 'duplicate', 'edit', 'execute', 'give', 'insert', 'invite', 'manage', 'mark', 'merge',
    'move', 'prepare', 'publish', 'put', 'react', 'remove', 'rename', 'reply', 'resolve', 'respond', 'restore',
    'restrict', 'retire', 'revoke', 'save', 'schedule', 'send', 'set', 'setup', 'share', 'sign', 'start', 'stop',
    'submit', 'toggle', 'transition', 'trash', 'trigger', 'unrestrict', 'unshare', 'update', 'upload', 'upsert', 'write',
  ];
  const words = name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  // Nouns as often as verbs: a write only where the verb goes.
  const leading = ['link', 'run', 'post', 'draft', 'comment', 'reply', 'schedule'];
  const writesAt = (w: string, i: number) => writes.includes(w) || (i < 2 && leading.includes(w));
  return words.some((w) => reads.includes(w)) && !words.some(writesAt);
}

/**
 * The guard's decision for one call: null lets it through to the usual
 * permission check, a string denies it with that reason. Self-contained
 * (no outer names): it also runs as the hook's script, from its own source.
 */
export function guardDecision(
  policy: GuardPolicy,
  call: { tool_name?: unknown; tool_input?: unknown },
  isRead: (name: string) => boolean,
  claimOnce: (file: string) => boolean
): string | null {
  const tool = typeof call.tool_name === 'string' ? call.tool_name : '';
  const input = call.tool_input && typeof call.tool_input === 'object' ? (call.tool_input as Record<string, unknown>) : {};
  if (policy.allow.includes(tool)) return null;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (policy.send && mcp && /Slack/i.test(mcp[1]!) && mcp[2] === 'slack_send_message') {
    const norm = (v: unknown) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim() : null);
    const { channel, thread, text, once } = policy.send;
    const same =
      input.channel_id === channel &&
      (thread ? input.thread_ts === thread : !input.thread_ts) &&
      !input.reply_broadcast &&
      norm(input.message) === norm(text);
    if (!same) return 'Rig sends only the message the person clicked Send on.';
    return claimOnce(once) ? null : 'Rig sends that message once.';
  }
  if (mcp && policy.readServers !== null && new RegExp(policy.readServers).test(mcp[1]!) && isRead(mcp[2]!)) return null;
  return `Rig's background sessions only read: ${tool || 'that'} isn't allowed here.`;
}

/** The hook's script: reads the call on stdin, prints a deny when the policy refuses it. Any failure blocks (exit 2). */
function guardScript(): string {
  return [
    // A bundler that keeps function names wraps them in `__name(…)`: harmless here.
    'const __name = (f) => f;',
    `const isRead = (${isReadTool.toString()});`,
    `const decide = (${guardDecision.toString()});`,
    'const fs = require("fs");',
    'try {',
    '  const policy = JSON.parse(Buffer.from(process.argv[process.argv.length - 1], "base64").toString("utf8"));',
    '  const call = JSON.parse(fs.readFileSync(0, "utf8"));',
    '  const claim = (file) => { try { fs.closeSync(fs.openSync(file, "wx")); return true; } catch { return false; } };',
    '  const reason = decide(policy, call, isRead, claim);',
    '  if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));',
    '  process.exit(0);',
    '} catch (e) {',
    '  process.stderr.write("Rig guard failed: " + String(e));',
    '  process.exit(2);',
    '}',
  ].join('\n');
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The guard as a shell command: the app's own Node (Electron as Node) runs
 * the script with the policy as its argument. If it can't run at all, `|| exit 2`
 * blocks the call: the guard fails closed.
 */
export function guardCommand(policy: GuardPolicy, node = process.execPath): string {
  const script = Buffer.from(guardScript(), 'utf8').toString('base64');
  const arg = Buffer.from(JSON.stringify(policy), 'utf8').toString('base64');
  return `ELECTRON_RUN_AS_NODE=1 ${quote(node)} -e ${quote(`eval(Buffer.from("${script}","base64").toString("utf8"))`)} ${quote(arg)} || exit 2`;
}

/** Settings that may switch hooks off or lock allow rules, as far as the lockdown cares. */
type HookSettings = { allowManagedHooksOnly?: unknown; disableAllHooks?: unknown; allowManagedPermissionRulesOnly?: unknown };

/** The Mac's IT-managed Claude Code settings (file, drop-ins, MDM profile, server-managed cache), and the person's own. */
export type ManagedTier = { managed: HookSettings[]; user: HookSettings[] };

/**
 * Whether the lockdown holds on this Mac. With no IT-managed tier, the policy
 * tier applies and the guard runs. With one, the policy tier is dropped, so
 * the guard must run: it doesn't when that tier (or the person's own
 * settings) turns hooks off, unless the tier also locks allow rules, when
 * the session's own handler still decides every call.
 */
export function lockdownHolds(tier: ManagedTier): boolean {
  if (tier.managed.length === 0) return true;
  const on = (v: unknown) => v === true || v === 'true';
  const rulesLocked = tier.managed.some((s) => on(s.allowManagedPermissionRulesOnly));
  const hooksOff = [...tier.managed, ...tier.user].some((s) => on(s.allowManagedHooksOnly) || (s.disableAllHooks !== undefined && s.disableAllHooks !== false && s.disableAllHooks !== 'false'));
  return rulesLocked || !hooksOff;
}

async function readJson(file: string): Promise<HookSettings | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as HookSettings) : null;
  } catch {
    return null;
  }
}

/** The MDM profile as JSON (macOS's own plutil), or null when there's none. */
function readPlist(file: string): Promise<HookSettings | null> {
  return new Promise((resolve) => {
    execFile('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { timeout: 5000 }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        resolve(JSON.parse(stdout) as HookSettings);
      } catch {
        resolve(null);
      }
    });
  });
}

/** Reads this Mac's managed tier and the person's own settings (macOS paths). */
export async function readManagedTier(): Promise<ManagedTier> {
  const dir = '/Library/Application Support/ClaudeCode';
  const dropIns = await readdir(join(dir, 'managed-settings.d')).catch(() => [] as string[]);
  const managed = await Promise.all([
    readJson(join(dir, 'managed-settings.json')),
    ...dropIns.filter((f) => f.endsWith('.json')).map((f) => readJson(join(dir, 'managed-settings.d', f))),
    readPlist('/Library/Managed Preferences/com.anthropic.claudecode.plist'),
    readJson(join(homedir(), '.claude', 'remote-settings.json')),
  ]);
  const user = await Promise.all([readJson(join(homedir(), '.claude', 'settings.json'))]);
  return { managed: managed.filter((s): s is HookSettings => s !== null), user: user.filter((s): s is HookSettings => s !== null) };
}

/**
 * Makes a session safe to run, or says why it isn't: the lockdown holds on
 * this Mac, and the session is in Ask first. On an error the session must not run.
 */
export async function askFirst(
  acp: Pick<SpacesAcpSessions, 'setConfig'>,
  conversationId: string,
  tier: () => Promise<ManagedTier> = readManagedTier
): Promise<Result<void, string>> {
  const managed = await tier().catch(() => null);
  if (!managed || !lockdownHolds(managed))
    return err("This Mac's managed Claude settings turn hooks off without locking allow rules, so Rig can't keep its reading sessions read-only.");
  if (!acp.setConfig) return err('This build cannot set the session mode.');
  return acp.setConfig(conversationId, { mode: LOCKED_MODE }).then(
    (r) => (r.success ? ok(undefined) : r),
    (e: unknown) => err(String(e))
  );
}
