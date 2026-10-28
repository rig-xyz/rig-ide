import { err, type Result } from '@emdash/shared';
import { RIG_TOOLS_SERVER } from '@shared/spaces/connectors';
import type { SpacesAcpSessions } from '../spaces/dispatch';

/**
 * How Rig runs a Claude session of its own that reads what other people
 * wrote (Slack, Linear, GitHub, the Feed): the orchestrator, a source run,
 * Home's chat and a card's Send. Text in what it reads can ask Claude to do
 * things, so the person's own Claude settings must never widen what such a
 * session can do, whatever their allow rules, hooks or default mode say.
 *
 * - The built-in tools that act or reach out (shell, file writes, the web,
 *   subagents) are denied outright: deny rules beat any allow rule.
 * - Starting work (rig_start) is denied too, unless the session is one the
 *   person talks to (Home's chat), where rig_start checks their turn.
 * - Their settings files can't allow a call or run a hook in the session, and
 *   there's no bypass mode (`appPermissionsOnly`, `noBypassPermissions`), so
 *   every other call comes to the session's own permission handler: reads
 *   only, or for a Send the one message.
 * - It runs in Ask first (`askFirst`), whatever their default mode.
 */

/** Built-in tools no locked session can use. */
export const LOCKED_DENIED_TOOLS = ['Bash', 'BashOutput', 'KillShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent'];

export const RIG_START_TOOL = `mcp__${RIG_TOOLS_SERVER}__rig_start`;

/** Claude Code's "Ask first": every call the deny rules don't settle comes to the permission handler. */
export const LOCKED_MODE = 'default';

/** The start-session options that lock a session down (the dispatch adapter's `startSession`). */
export function lockedSession(opts: { rigStart?: boolean } = {}) {
  return {
    disallowedTools: [...LOCKED_DENIED_TOOLS, ...(opts.rigStart ? [] : [RIG_START_TOOL])],
    noBypassPermissions: true,
    appPermissionsOnly: true,
  };
}

/** Puts a session in Ask first; an error when it can't, and then the session must not run. */
export function askFirst(acp: Pick<SpacesAcpSessions, 'setConfig'>, conversationId: string): Promise<Result<void, string>> {
  if (!acp.setConfig) return Promise.resolve(err('This build cannot set the session mode.'));
  return acp.setConfig(conversationId, { mode: LOCKED_MODE }).catch((e: unknown) => err(String(e)));
}

const READ_VERBS = new Set(['list', 'get', 'search', 'read', 'fetch', 'query', 'find', 'view']);
/** Words that make a tool more than a read, wherever they are in its name: `get_or_create`, `mark_read`, `read_and_delete`. */
const WRITE_WORDS = new Set([
  'add', 'apply', 'approve', 'archive', 'assign', 'cancel', 'close', 'comment', 'copy', 'create', 'delete', 'draft', 'edit',
  'execute', 'give', 'invite', 'mark', 'merge', 'move', 'post', 'put', 'react', 'remove', 'rename', 'reply', 'resolve',
  'respond', 'restore', 'retire', 'run', 'save', 'schedule', 'send', 'set', 'share', 'sign', 'start', 'stop', 'submit',
  'toggle', 'transition', 'trash', 'trigger', 'unshare', 'update', 'upload', 'upsert', 'write',
]);

/**
 * Whether a connector tool (its name after `mcp__<server>__`) only reads: it
 * starts with a read verb, or one word and then a read verb (`slack_read_thread`,
 * `getJiraIssue`), and no word in it writes.
 */
export function isReadTool(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const verb = READ_VERBS.has(words[0] ?? '') || READ_VERBS.has(words[1] ?? '');
  return verb && !words.some((w) => WRITE_WORDS.has(w));
}
