import type { AcpPermissionRequest } from '@emdash/core/acp';
import { ok } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import type { RigFeedItem, RigSituation } from '@shared/rig/feed';
import type { RawSessionEvent } from '../spaces/dispatch';
import { checkPermission, checkPrompt, dueChecks, RECHECK_MS, runCheck, toCheckEvent } from './checks';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const perm = (title: string) =>
  ({ requestId: 'r', toolCall: { title }, options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] }) as unknown as AcpPermissionRequest;
const item = (id: string, updatedAt = '2026-10-23T10:00:00Z') => ({ situationId: id, updatedAt }) as RigFeedItem;
const situation: RigSituation = {
  id: 'sit_1',
  title: 'Riyad asks for a PR review',
  description: 'Riyad asked Dylan to finish reviewing the onramp PRs today.',
  status: 'open',
  participants: ['Riyad Hasanov'],
  decision: null,
  explain: null,
  events: [
    { id: 'ev1', ref: 'msg:slack:C1:1.1', source: 'slack', from: 'Riyad Hasanov', title: '#eng', summary: '', excerpt: 'Can you finish reviewing the PRs today?', url: 'https://x.slack.com/archives/C1/p11', at: '2026-10-23T09:00:00Z', attachedBy: 'new' },
  ],
};

describe('checks', () => {
  it('are due for visible cards never checked, or with new evidence after the wait', () => {
    const records = {
      a: { at: '2026-10-23T11:00:00Z', seen: '2026-10-23T10:00:00Z', status: 'ok' as const, found: 0 },
      b: { at: new Date(NOW - RECHECK_MS).toISOString(), seen: '2026-10-23T05:00:00Z', status: 'ok' as const, found: 1 },
      c: { at: new Date(NOW - RECHECK_MS).toISOString(), seen: '2026-10-23T10:00:00Z', status: 'ok' as const, found: 0 },
    };
    expect(dueChecks([item('a', '2026-10-23T11:30:00Z'), item('b'), item('c'), item('d')], records, NOW).map((x) => x.situationId)).toEqual(['b', 'd']);
  });

  it("allow any connector's read tools and refuse writes and everything else", () => {
    expect(checkPermission(perm('mcp__claude_ai_GitHub__get_pull_request'))).toBe('yes');
    expect(checkPermission(perm('mcp__claude_ai_Slack__slack_read_thread'))).toBe('yes');
    expect(checkPermission(perm('mcp__claude_ai_Slack__slack_send_message'))).toBe('no');
    expect(checkPermission(perm('mcp__rig__rig_act'))).toBe('no');
    expect(checkPermission(perm('Bash'))).toBe('no');
    // GitHub goes through rig_github (checked gh reads, no shell); a shell command is refused, even a gh read.
    expect(checkPermission(perm('mcp__rig__rig_github'))).toBe('yes');
    const sh = (command: string) =>
      ({ requestId: 'r', toolCall: { kind: 'execute-tool-call', title: command, command }, options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] }) as unknown as AcpPermissionRequest;
    expect(checkPermission(sh('gh pr view 555 --repo acme/ramps --json state,mergedAt'))).toBe('no');
    expect(checkPermission(sh('gh pr merge 555'))).toBe('no');
    // Anchored: a read verb inside a write's name isn't a read.
    expect(checkPermission(perm('mcp__claude_ai_Slack__slack_mark_read'))).toBe('no');
    expect(checkPermission(perm('mcp__claude_ai_Linear__get_or_create_label'))).toBe('no');
    expect(checkPermission(perm('mcp__claude_ai_Atlassian__getJiraIssue'))).toBe('yes');
    expect(checkPermission(perm('mcp__claude_ai_Atlassian__addCommentToJiraIssue'))).toBe('no');
    // A gh read stays on github.com: no --web, no other host.
    expect(checkPermission(sh('gh pr view 555 --web'))).toBe('no');
    expect(checkPermission(sh('gh pr view 555 --repo evil.example.com/a/b'))).toBe('no');
  });

  it('ask about the situation with its links', () => {
    const prompt = checkPrompt(situation, 'Dylan Bourgeois');
    expect(prompt).toContain('Rig is about to show Dylan Bourgeois this card');
    expect(prompt).toContain('a reply they sent counts');
    expect(prompt).toContain('(https://x.slack.com/archives/C1/p11)');
  });

  it('turn a finding into an event for its situation', () => {
    expect(toCheckEvent('sit_1', { source: 'GitHub', ref: 'acme/ramps#555', url: 'https://github.com/acme/ramps/pull/555', at: '2026-10-23T08:00:00Z', fact: 'acme/ramps#555 was merged by Riyad Hasanov.', settles: true }, NOW)).toEqual({
      sourceKey: 'check:sit_1:github:acme/ramps#555:2026-10-23T08:00:00.000Z',
      source: 'github',
      kind: 'settled',
      ref: 'check:github:acme/ramps#555',
      title: 'acme/ramps#555 was merged by Riyad Hasanov.',
      summary: 'Rig checked: this settles it, nothing left for the person to do.',
      excerpt: 'acme/ramps#555 was merged by Riyad Hasanov.',
      at: '2026-10-23T08:00:00.000Z',
      meta: { url: 'https://github.com/acme/ramps/pull/555', check: true },
      sessionFor: 'sit_1',
    });
    expect(toCheckEvent('sit_1', { source: 'slack', ref: 'C1:2.2', fact: 'Still open.', at: 'tomorrow' }, NOW)?.at).toBe(new Date(NOW).toISOString());
    expect(toCheckEvent('sit_1', { source: 'slack', ref: 'C1:3.3', fact: 'The cs question was answered.', still_open: 'the sync and docs', settles: false }, NOW)?.summary).toBe(
      'Rig checked: still open for the person: the sync and docs'
    );
    expect(toCheckEvent('sit_1', { source: 'slack', fact: 'no ref' }, NOW)).toBeNull();
  });

  it('a check reads the situation, asks a read-only session and sends only what it found', async () => {
    const answers = ['[{"source":"github","ref":"acme/ramps#555","at":"2026-10-23T08:00:00Z","fact":"Merged.","settles":true}]', '[]'];
    let emit: (e: RawSessionEvent) => void = () => {};
    const acp = {
      startSession: vi.fn(async (_input: Record<string, unknown>) => ok({ sessionId: 's' })),
      setConfig: vi.fn(async (_id: string, _change: Record<string, unknown>) => ok(undefined)),
      stopSession: vi.fn(async () => {}),
      subscribeRaw: vi.fn(async (_id: string, on: (e: RawSessionEvent) => void) => ((emit = on), () => {})),
      subscribePendingPermissions: vi.fn(async () => () => {}),
      resolvePermission: vi.fn(async () => {}),
      queuePrompt: vi.fn(async () => {
        const text = answers.shift()!;
        setTimeout(() => {
          emit({ kind: 'turn_start', turnId: 't' });
          emit({ kind: 'acp_update', sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text } } });
          emit({ kind: 'turn_end', turnId: 't', stopReason: 'end_turn' });
        }, 0);
        return ok({ turnId: null });
      }),
    };
    const postEvents = vi.fn(async (events: unknown[]) => ok({ added: events.length }));
    const deps = { acp, cwd: async () => '/tmp/w', newConversationId: () => 'watch-1', situation: async () => ok(situation), postEvents, me: 'Dylan Bourgeois' };
    expect(await runCheck(deps, 'sit_1', NOW)).toEqual({ status: 'ok', found: 1, added: 1 });
    expect(postEvents.mock.calls[0]![0]).toMatchObject([{ sessionFor: 'sit_1', kind: 'settled' }]);
    expect(await runCheck(deps, 'sit_1', NOW)).toEqual({ status: 'ok', found: 0, added: 0 });
    expect(postEvents).toHaveBeenCalledTimes(1);
    expect(acp.stopSession).toHaveBeenCalledTimes(2);
    // Locked down, in Ask first.
    expect(acp.startSession).toHaveBeenCalledWith(expect.objectContaining({ noBypassPermissions: true, appPermissionsOnly: true }));
    expect(acp.setConfig).toHaveBeenCalledWith('watch-1', { mode: 'default' });
  });

  it('a GitHub check reads through rig_github, with no shell: its Rig tools server, its permission, its guard', async () => {
    let emit: (e: RawSessionEvent) => void = () => {};
    let ask: (r: AcpPermissionRequest) => void = () => {};
    const reader = { type: 'http' as const, name: 'rig', url: 'http://127.0.0.1:1/mcp', headers: [] };
    const acp = {
      startSession: vi.fn(async (_input: Record<string, unknown>) => ok({ sessionId: 's' })),
      setConfig: vi.fn(async () => ok(undefined)),
      stopSession: vi.fn(async () => {}),
      subscribeRaw: vi.fn(async (_id: string, on: (e: RawSessionEvent) => void) => ((emit = on), () => {})),
      subscribePendingPermissions: vi.fn(async (_id: string, on: (r: AcpPermissionRequest) => void) => ((ask = on), () => {})),
      resolvePermission: vi.fn(async () => {}),
      queuePrompt: vi.fn(async () => {
        setTimeout(() => {
          emit({ kind: 'turn_start', turnId: 't' });
          // Claude looks the PR up with rig_github; Bash isn't there to ask for.
          ask({ requestId: 'gh', toolCall: { title: 'mcp__rig__rig_github' }, options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] } as unknown as AcpPermissionRequest);
          const text = '[{"source":"github","ref":"acme/ramps#555","at":"2026-10-23T08:00:00Z","fact":"acme/ramps#555 merged.","settles":true}]';
          emit({ kind: 'acp_update', sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text } } });
          emit({ kind: 'turn_end', turnId: 't', stopReason: 'end_turn' });
        }, 0);
        return ok({ turnId: null });
      }),
    };
    const readerTools = vi.fn(async () => reader);
    const postEvents = vi.fn(async (events: unknown[]) => ok({ added: events.length }));
    const deps = { acp, readerTools, cwd: async () => '/tmp/w', newConversationId: () => 'check-1', situation: async () => ok(situation), postEvents, me: 'Dylan Bourgeois' };
    expect(await runCheck(deps, 'sit_1', NOW)).toEqual({ status: 'ok', found: 1, added: 1 });
    expect(readerTools).toHaveBeenCalledWith('/tmp/w');
    const started = acp.startSession.mock.calls[0]![0] as { mcpServers: unknown[]; disallowedTools: string[]; toolGuardCommand: string; systemPromptAppend: string };
    expect(started.mcpServers).toEqual([reader]);
    expect(started.disallowedTools).toContain('Bash');
    expect(started.systemPromptAppend).toContain('rig_github');
    expect(acp.resolvePermission).toHaveBeenCalledWith('check-1', 'gh', 'yes');
    // The guard lets rig_github through too.
    const policy = JSON.parse(Buffer.from(/'([A-Za-z0-9+/=]+)' \|\| exit 2$/.exec(started.toolGuardCommand)![1]!, 'base64').toString('utf8')) as { allow: string[] };
    expect(policy.allow).toContain('mcp__rig__rig_github');
  });
});
