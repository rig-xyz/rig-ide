import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import { askFirst, guardCommand, guardDecision, isReadTool, lockdownHolds, lockedSession, type GuardPolicy } from './lockdown';

/**
 * Real tool names of the connectors in Dylan's Claude (as Claude Code lists
 * them after `mcp__<server>__`): every read passes, every write fails.
 */
const READS: Record<string, string[]> = {
  slack: ['slack_search_public', 'slack_search_public_and_private', 'slack_search_channels', 'slack_search_users', 'slack_search_emojis', 'slack_read_channel', 'slack_read_thread', 'slack_read_canvas', 'slack_read_file', 'slack_read_user_profile', 'slack_get_reactions', 'slack_list_channel_members'],
  linear: ['list_issues', 'get_issue', 'get_issue_status', 'list_comments', 'list_projects', 'get_project', 'list_cycles', 'list_documents', 'get_document', 'list_users', 'get_user', 'get_team', 'list_teams', 'get_diff', 'get_diff_threads', 'list_diffs', 'get_notifications', 'get_attachment', 'extract_images', 'search_documentation', 'list_issue_labels', 'list_issue_statuses', 'get_milestone', 'list_milestones', 'get_release', 'list_releases', 'get_status_updates', 'get_agent_skill', 'list_agent_skills', 'get_triage_responsibility'],
  granola: ['get_meetings', 'list_meetings', 'get_meeting_transcript', 'get_meeting_attachment', 'query_granola_meetings', 'search_meetings', 'list_meeting_folders', 'get_account_info'],
  drive: ['search_files', 'list_recent_files', 'read_file_content', 'download_file_content', 'get_file_metadata', 'get_file_permissions', 'google_drive_search', 'google_drive_fetch'],
  calendar: ['list_calendars', 'list_events', 'get_event', 'search_events', 'suggest_time'],
  gmail: ['gmail_search_messages', 'gmail_read_message', 'gmail_read_thread', 'gmail_list_labels', 'gmail_list_drafts', 'gmail_get_profile', 'search_threads', 'get_thread', 'outlook_email_search'],
  atlassian: ['getJiraIssue', 'searchJiraIssuesUsingJql', 'getConfluencePage', 'getConfluenceCommentChildren', 'getConfluencePageFooterComments', 'getConfluencePageInlineComments', 'getConfluenceSpaces', 'getPagesInConfluenceSpace', 'searchConfluenceUsingCql', 'lookupJiraAccountId', 'getAccessibleAtlassianResources', 'atlassianUserInfo', 'getTransitionsForJiraIssue', 'getVisibleJiraProjects', 'getJiraIssueTypeMetaWithFields', 'getJiraIssueRemoteIssueLinks', 'getIssueLinkTypes', 'getTeamworkGraphContext', 'getContentFormatGuide', 'getCompassComponents', 'fetch', 'search'],
  launchdarkly: ['get-flag', 'list-flags', 'get-flag-health', 'get-flag-status-across-envs', 'find-stale-flags', 'find-members', 'check-flag-rollout-complete', 'check-removal-readiness', 'query-logs', 'query-traces', 'query-change-history', 'search-docs', 'get-doc', 'preview-graph', 'match-release-policies', 'get-evaluation-run-summary', 'list-release-autopilot-repo-settings', 'get-member-self', 'get-keys'],
  langfuse: ['getPrompt', 'getPromptUnresolved', 'listPrompts', 'queryMetrics', 'listScores', 'getObservation', 'listObservations', 'getObservationFilterValues', 'getHealth', 'listDatasetRunItems', 'getDatasetRun', 'getV4MigrationData', 'listManagedEvaluatorTemplates', 'loadSkill', 'loadSkillResource'],
  notion: ['notion-search', 'notion-fetch', 'notion-get-users', 'notion-get-self', 'notion-get-teams', 'notion-get-comments'],
  ramp: ['get_transactions', 'list_transactions', 'get_transaction', 'list_cards', 'list_reimbursements', 'list_bills', 'get_ramp_categories', 'list_users'],
};
const WRITES: Record<string, string[]> = {
  slack: ['slack_send_message', 'slack_send_message_draft', 'slack_schedule_message', 'slack_add_reaction', 'slack_create_canvas', 'slack_update_canvas', 'slack_create_conversation', 'slack_mark_read'],
  linear: ['save_issue', 'save_comment', 'delete_comment', 'create_issue_label', 'save_project', 'mark_notification', 'merge_diff', 'prepare_attachment_upload', 'resolve_diff_thread', 'restore_issue_label', 'retire_project_label', 'share_issue', 'unshare_issue', 'submit_diff_review', 'update_diff', 'create_attachment', 'delete_attachment', 'get_or_create_label'],
  granola: ['add_note_to_folder', 'create_folder', 'remove_note_from_folder', 'update_folder', 'give_feedback', 'sign_out'],
  drive: ['copy_file', 'create_file', 'share_file', 'trash_file', 'update_file'],
  calendar: ['create_event', 'delete_event', 'respond_to_event', 'update_event'],
  gmail: ['gmail_create_draft', 'gmail_send_message', 'create_draft', 'send_email', 'gmail_read_and_delete'],
  atlassian: ['addCommentToJiraIssue', 'addWorklogToJiraIssue', 'createJiraIssue', 'editJiraIssue', 'transitionJiraIssue', 'createConfluencePage', 'updateConfluencePage', 'createConfluenceFooterComment', 'createConfluenceInlineComment', 'createIssueLink', 'addTeamworkGraphContext', 'createCompassComponent'],
  launchdarkly: ['create-flag', 'toggle-flag', 'update-rollout', 'delete-flag', 'archive-flag', 'copy-flag-config', 'apply-approval-request', 'start-guarded-rollout', 'stop-experiment-iteration', 'invite-members', 'manage-expiring-targets', 'link-view-resources', 'save-and-start-experiment-iteration', 'setup-agentcontrol-config', 'clone-agentcontrol-config-variation', 'restrict-agentcontrol-model-configs', 'vent'],
  langfuse: ['createScore', 'createChatPrompt', 'deleteDataset', 'updatePromptLabels', 'upsertDataset', 'batchUpsertDatasetItems', 'attachEvaluatorToEvaluationRule', 'detachEvaluatorFromEvaluationRule', 'addDashboardPlacement', 'runBatchEvaluation', 'testEvaluator', 'submitFeedback'],
  notion: ['notion-create-pages', 'notion-update-page', 'notion-move-pages', 'notion-duplicate-page', 'notion-create-database', 'notion-create-comment'],
  ramp: ['create_virtual_card', 'update_transaction', 'submit_receipt', 'approve_reimbursement'],
};

describe('locked-down sessions', () => {
  it('deny what acts or reaches out, and rig_start unless the session is one the person talks to; and carry the guard', () => {
    const locked = lockedSession();
    expect(locked).toMatchObject({ noBypassPermissions: true, appPermissionsOnly: true });
    expect(locked.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'mcp__rig__rig_start']));
    expect(lockedSession({ rigStart: true }).disallowedTools).not.toContain('mcp__rig__rig_start');
    expect(locked.toolGuardCommand).toMatch(/ \|\| exit 2$/);
  });

  for (const [connector, names] of Object.entries(READS))
    it(`takes every ${connector} read for a read`, () => {
      for (const name of names) expect(isReadTool(name), name).toBe(true);
    });
  for (const [connector, names] of Object.entries(WRITES))
    it(`takes no ${connector} write for a read`, () => {
      for (const name of names) expect(isReadTool(name), name).toBe(false);
    });
  it('refuses a name with no read verb', () => {
    for (const name of ['do_thing', 'vent', 'whatever', '']) expect(isReadTool(name), name).toBe(false);
  });
});

const claimed = new Set<string>();
const claim = (file: string) => (claimed.has(file) ? false : (claimed.add(file), true));
const policy = (over: Partial<GuardPolicy> = {}): GuardPolicy => ({ allow: ['Read', 'mcp__rig__rig_github'], readServers: '^claude_ai_', ...over });
const decide = (p: GuardPolicy, tool_name: string, tool_input: Record<string, unknown> = {}) => guardDecision(p, { tool_name, tool_input }, isReadTool, claim);

describe('the guard', () => {
  it('lets reads and the session’s own tools through, and denies everything else', () => {
    expect(decide(policy(), 'Read')).toBeNull();
    expect(decide(policy(), 'mcp__rig__rig_github')).toBeNull();
    expect(decide(policy(), 'mcp__claude_ai_Slack__slack_read_thread')).toBeNull();
    expect(decide(policy(), 'mcp__claude_ai_Slack__slack_send_message')).toMatch(/only read/);
    expect(decide(policy(), 'mcp__claude_ai_Linear__save_issue')).toMatch(/only read/);
    expect(decide(policy(), 'mcp__rig__rig_start')).toMatch(/only read/);
    expect(decide(policy(), 'Bash')).toMatch(/only read/);
    expect(decide(policy(), 'WebFetch')).toMatch(/only read/);
    // Reads only on the servers it names: not the person's own local MCP servers.
    expect(decide(policy(), 'mcp__my_files__read_file')).toMatch(/only read/);
    expect(decide(policy({ readServers: '^claude_ai_Linear$' }), 'mcp__claude_ai_Slack__slack_read_thread')).toMatch(/only read/);
  });

  it('lets a Send through only with its exact message, once', () => {
    const p = policy({ readServers: null, allow: [], send: { channel: 'C1', thread: '1.1', text: 'On it.\n', once: '/tmp/once-a' } });
    const call = { channel_id: 'C1', thread_ts: '1.1', message: 'On it.' };
    expect(decide(p, 'mcp__claude_ai_Slack__slack_send_message', { ...call, message: 'Something else.' })).toMatch(/only the message/);
    expect(decide(p, 'mcp__claude_ai_Slack__slack_send_message', { ...call, channel_id: 'C2' })).toMatch(/only the message/);
    expect(decide(p, 'mcp__claude_ai_Slack__slack_send_message', { ...call, reply_broadcast: true })).toMatch(/only the message/);
    expect(decide(p, 'mcp__claude_ai_Slack__slack_send_message', call)).toBeNull();
    expect(decide(p, 'mcp__claude_ai_Slack__slack_send_message', call)).toMatch(/once/);
    expect(decide(p, 'mcp__claude_ai_Slack__slack_read_thread')).toMatch(/only read/);
  });
});

/** Runs the guard as Claude Code does: the command in a shell, the call on stdin. */
function runGuard(command: string, call: Record<string, unknown>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = execFile('/bin/sh', ['-c', command], (error, stdout) => resolve({ code: error ? Number(error.code ?? 1) : 0, out: stdout }));
    child.stdin!.end(JSON.stringify(call));
  });
}

describe('the guard command', () => {
  it('denies a write whatever allow rule the person has: it runs before the permission check, from its own source', async () => {
    const { toolGuardCommand } = lockedSession({ policy: { allow: ['mcp__rig__rig_github'] } });
    // The person's settings may allow mcp__claude_ai_Slack__* outright; the guard never reads them.
    const denied = await runGuard(toolGuardCommand, { hook_event_name: 'PreToolUse', tool_name: 'mcp__claude_ai_Slack__slack_send_message', tool_input: { channel_id: 'C1', message: 'hi' } });
    expect(denied.code).toBe(0);
    expect(JSON.parse(denied.out)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: expect.stringMatching(/only read/) } });
    const read = await runGuard(toolGuardCommand, { hook_event_name: 'PreToolUse', tool_name: 'mcp__claude_ai_Slack__slack_read_thread', tool_input: {} });
    expect(read).toEqual({ code: 0, out: '' });
    const github = await runGuard(toolGuardCommand, { hook_event_name: 'PreToolUse', tool_name: 'mcp__rig__rig_github', tool_input: { command: 'gh pr view 1' } });
    expect(github).toEqual({ code: 0, out: '' });
  });

  it('claims a Send once, across calls', async () => {
    const once = join(mkdtempSync(join(tmpdir(), 'rig-guard-')), 'send.once');
    const { toolGuardCommand } = lockedSession({ policy: { readServers: null, send: { channel: 'C1', thread: null, text: 'Hi', once } } });
    const call = { tool_name: 'mcp__claude_ai_Slack__slack_send_message', tool_input: { channel_id: 'C1', message: 'Hi' } };
    expect(await runGuard(toolGuardCommand, call)).toEqual({ code: 0, out: '' });
    expect(existsSync(once)).toBe(true);
    expect(JSON.parse((await runGuard(toolGuardCommand, call)).out).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('fails closed: a guard that can’t run, or can’t read the call, blocks it (exit 2)', async () => {
    const policyOf: GuardPolicy = { allow: [], readServers: null };
    expect((await runGuard(guardCommand(policyOf, '/nonexistent/node'), { tool_name: 'Read' })).code).toBe(2);
    const broken = await new Promise<number>((resolve) => {
      const child = execFile('/bin/sh', ['-c', guardCommand(policyOf)], (error) => resolve(error ? Number(error.code) : 0));
      child.stdin!.end('not json');
    });
    expect(broken).toBe(2);
  });
});

describe('where the lockdown holds', () => {
  it('holds with no IT-managed tier, or one that leaves hooks on or locks allow rules; not otherwise', () => {
    expect(lockdownHolds({ managed: [], user: [{ disableAllHooks: true }] })).toBe(true);
    expect(lockdownHolds({ managed: [{}], user: [] })).toBe(true);
    expect(lockdownHolds({ managed: [{ allowManagedHooksOnly: true, allowManagedPermissionRulesOnly: true }], user: [] })).toBe(true);
    expect(lockdownHolds({ managed: [{ allowManagedHooksOnly: true }], user: [] })).toBe(false);
    expect(lockdownHolds({ managed: [{}], user: [{ disableAllHooks: true }] })).toBe(false);
  });

  it("doesn't let a session run where it doesn't hold", async () => {
    const setConfig = vi.fn(async () => ok(undefined));
    expect((await askFirst({ setConfig }, 'c', async () => ({ managed: [{ disableAllHooks: true }], user: [] }))).success).toBe(false);
    expect(setConfig).not.toHaveBeenCalled();
    expect((await askFirst({ setConfig }, 'c', async () => ({ managed: [], user: [] }))).success).toBe(true);
    expect(setConfig).toHaveBeenCalledWith('c', { mode: 'default' });
  });
});
