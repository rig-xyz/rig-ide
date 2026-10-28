import type { AcpPermissionRequest } from '@emdash/core/acp';
import { err, ok } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import type { RawSessionEvent } from '../spaces/dispatch';
import { dueSources, parseJsonArray, runSource, sourcePermission, toImportEvent, type Source } from './sources';

const linear: Source = { ref: 'src_linear', connector: 'Linear', what: 'issues in Ulys', everyMin: 30, paused: false, cursor: '2026-10-22T00:00:00Z', lastRun: null, lastStatus: null, lastCount: 0 };
const perm = (title: string) =>
  ({ requestId: 'r', toolCall: { title }, options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] }) as unknown as AcpPermissionRequest;

describe('sources', () => {
  it("allow only the source connector's read tools", () => {
    expect(sourcePermission('Linear', perm('mcp__claude_ai_Linear__list_issues'))).toBe('yes');
    expect(sourcePermission('Linear', perm('mcp__claude_ai_Linear__save_issue'))).toBe('no');
    expect(sourcePermission('Linear', perm('mcp__claude_ai_Slack__list_messages'))).toBe('no');
    expect(sourcePermission('Linear', perm('Bash'))).toBe('no');
    expect(sourcePermission('Linear', perm('mcp__claude_ai_Linear__get_or_create_label'))).toBe('no');
    expect(sourcePermission('Slack', perm('mcp__claude_ai_Slack__slack_mark_read'))).toBe('no');
  });

  it('read the JSON array out of an answer, and map Linear and Slack lines to events', () => {
    expect(parseJsonArray('Here you go:\n[{"id":"ULY-1"}]\nDone.')).toEqual([{ id: 'ULY-1' }]);
    expect(parseJsonArray('I could not reach Linear.')).toBeNull();
    expect(toImportEvent(linear, { id: 'ULY-1', title: 'Fix it', state: 'Todo', priority: 'High', assignee: 'Riyad', updatedAt: '2026-10-23T10:00:00Z', summary: 'A bug' })).toMatchObject({
      sourceKey: 'ULY-1@2026-10-23T10:00:00Z', ref: 'item:ULY-1', from: 'Riyad', title: 'ULY-1: Fix it', summary: 'Todo · High · owner Riyad', excerpt: 'A bug',
    });
    expect(toImportEvent(linear, { title: 'no id' })).toBeNull();
    const slack = { ...linear, ref: 'src_slack', connector: 'Slack' };
    expect(toImportEvent(slack, { ts: '1792000000.1', channel: 'eng', channelId: 'C1', threadTs: '1791999999.5', from: 'Peter', text: 'merged' })).toMatchObject({
      ref: 'msg:slack:C1:1792000000.1', threadKey: 'slack:C1:1791999999.5', kind: 'thread reply', title: '#eng',
    });
  });

  it('a run lists, maps, sends and moves the cursor', async () => {
    const answer = '[{"id":"ULY-2","title":"A","updatedAt":"2026-10-23T09:00:00Z"},{"id":"ULY-3","title":"B","updatedAt":"2026-10-23T11:00:00Z"}]';
    let emit: (e: RawSessionEvent) => void = () => {};
    const acp = {
      startSession: vi.fn(async (_input: Record<string, unknown>) => ok({ sessionId: 's' })),
      setConfig: vi.fn(async (_id: string, _change: Record<string, unknown>) => ok(undefined)),
      stopSession: vi.fn(async () => {}),
      subscribeRaw: vi.fn(async (_id: string, on: (e: RawSessionEvent) => void) => ((emit = on), () => {})),
      subscribePendingPermissions: vi.fn(async () => () => {}),
      resolvePermission: vi.fn(async () => {}),
      queuePrompt: vi.fn(async (_id: string, _text: string) => {
        setTimeout(() => {
          emit({ kind: 'turn_start', turnId: 't' });
          emit({ kind: 'acp_update', sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', messageId: 'm', content: { type: 'text', text: answer } } });
          emit({ kind: 'turn_end', turnId: 't', stopReason: 'end_turn' });
        }, 0);
        return ok({ turnId: null });
      }),
    };
    const postEvents = vi.fn(async (events: unknown[]) => ok({ added: events.length }));
    const out = await runSource({ acp, cwd: async () => '/tmp/w', newConversationId: () => 'watch-1', postEvents, now: () => Date.parse('2026-10-23T12:00:00Z') }, linear);
    expect(out).toEqual({ status: 'ok', listed: 2, added: 2, cursor: '2026-10-23T11:00:00.000Z' });
    expect(acp.queuePrompt.mock.calls[0]![1]).toContain('updated after 2026-10-22T00:00:00Z');
    expect(acp.stopSession).toHaveBeenCalledWith('watch-1');
    // Locked down whatever the person's own settings allow: deny rules, no bypass, no settings allow rules or hooks, Ask first.
    const input = acp.startSession.mock.calls[0]![0];
    expect(input).toMatchObject({ noBypassPermissions: true, appPermissionsOnly: true });
    expect(input.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Write', 'WebFetch', 'WebSearch', 'Task', 'mcp__rig__rig_start']));
    expect(acp.setConfig).toHaveBeenCalledWith('watch-1', { mode: 'default' });
  });

  it("doesn't read when the session can't be put in Ask first", async () => {
    const acp = {
      startSession: vi.fn(async () => ok({ sessionId: 's' })),
      setConfig: vi.fn(async () => err('no modes')),
      stopSession: vi.fn(async () => {}),
      subscribeRaw: vi.fn(async () => () => {}),
      subscribePendingPermissions: vi.fn(async () => () => {}),
      resolvePermission: vi.fn(async () => {}),
      queuePrompt: vi.fn(async () => ok({ turnId: null })),
    };
    const out = await runSource({ acp, cwd: async () => '/tmp/w', newConversationId: () => 'watch-2', postEvents: vi.fn(), now: () => Date.parse('2026-10-23T12:00:00Z') }, linear);
    expect(out.status).toBe('failed');
    expect(acp.queuePrompt).not.toHaveBeenCalled();
    expect(acp.stopSession).toHaveBeenCalledWith('watch-2');
  });

  it('are due on their schedule unless paused or running', () => {
    const now = Date.parse('2026-10-23T12:00:00Z');
    expect(dueSources([linear, { ...linear, ref: 'b', lastRun: '2026-10-23T11:45:00Z' }, { ...linear, ref: 'c', paused: true }], now).map((s) => s.ref)).toEqual(['src_linear']);
  });
});
