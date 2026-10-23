import type { AcpPermissionRequest } from '@emdash/core/acp';
import { ok } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import type { OrchAgentState } from '../feed/relay';
import type { RawSessionEvent } from '../spaces/dispatch';
import { agentPermission, buildPacket, createOrchestrator } from './agent';

const NOW = Date.parse('2026-10-23T13:00:00Z');
const perm = (title: string, extra: Record<string, unknown> = {}) =>
  ({ requestId: 'r', toolCall: { title, ...extra }, options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] }) as unknown as AcpPermissionRequest;

const state = (over: Partial<OrchAgentState> = {}): OrchAgentState => ({
  me: 'Dylan Bourgeois',
  profile: 'Dylan Bourgeois (also "Dylan"). CTO of Ulys.',
  rules: [{ ref: 'rule_1', text: 'Investors come to me first.' }],
  lastRun: { id: 'run_prev', at: '2026-10-23T12:00:00Z' },
  cursors: { slack: '2026-10-23T11:58:00Z' },
  due: [{ ref: 'sit_1', title: 'Christopher asks for approval on #343', at: '2026-10-23T12:30:00Z', why: 'date' }],
  events: [{ ref: 'oev_9', source: 'session', kind: 'result', line: 'Traced ULY-523', for: 'sit_2', at: '2026-10-23T12:40:00Z' }],
  counts: { open: 12, visible: 6, queued: 9 },
  bare: [{ ref: 'sit_3', title: 'Old pipeline card' }],
  ...over,
});

describe('the background orchestrator', () => {
  it('builds a short packet: who, rules, and where to look', () => {
    const packet = buildPacket({ runId: 'run_x', now: NOW, trigger: 'schedule', turnId: 'turn_1', state: state(), sources: [{ connector: 'Slack', what: 'your DMs' }, { connector: 'Linear', what: 'Ulys issues' }] });
    expect(packet).toContain('<run id="run_x" now="2026-10-23T13:00:00.000Z" trigger="schedule" budget="20 lookups, 3 starts"/>');
    expect(packet).toContain('<rig_turn user_turn_id="turn_1" />');
    expect(packet).toContain('CTO of Ulys');
    expect(packet).toContain('rule_1 "Investors come to me first."');
    expect(packet).toContain('slack: your DMs, since 2026-10-23T11:58:00Z');
    // A source with no cursor yet reads from the last run.
    expect(packet).toContain('linear: Ulys issues, since 2026-10-23T12:00:00Z');
    expect(packet).toContain('Visible with no card written (your owner sees nothing there): sit_3 "Old pipeline card"');
    expect(packet).toContain('name each source exactly as above (slack, linear)');
    expect(packet).toContain('Due now: sit_1 "Christopher asks for approval on #343"');
    expect(packet).toContain('oev_9 session for sit_2: Traced ULY-523');
    expect(packet).toContain('Open: 12 situations, 6 cards visible, 9 queued');
  });

  it("allows its own Rig tools and read-only lookups, and refuses everything else", () => {
    expect(agentPermission(perm('mcp__rig__rig_feed'))).toBe('yes');
    expect(agentPermission(perm('mcp__rig__rig_start'))).toBe('yes');
    expect(agentPermission(perm('mcp__rig__rig_chat_read'))).toBe('no');
    expect(agentPermission(perm('mcp__claude_ai_Slack__slack_read_thread'))).toBe('yes');
    expect(agentPermission(perm('mcp__claude_ai_Slack__slack_send_message'))).toBe('no');
    expect(agentPermission(perm('gh pr view 343 --repo Ulysholdings/mobile-ios-v2', { kind: 'execute-tool-call', command: 'gh pr view 343 --repo Ulysholdings/mobile-ios-v2' }))).toBe('yes');
    expect(agentPermission(perm('gh pr merge 343', { kind: 'execute-tool-call', command: 'gh pr merge 343' }))).toBe('no');
  });

  it('runs one turn on a session it keeps, records the run, and writes a note when Claude left none', async () => {
    let emit: (e: RawSessionEvent) => void = () => {};
    const acp = {
      startSession: vi.fn(async () => ok({ sessionId: 's' })),
      stopSession: vi.fn(async () => {}),
      subscribeRaw: vi.fn(async (_id: string, on: (e: RawSessionEvent) => void) => ((emit = on), () => {})),
      subscribePendingPermissions: vi.fn(async () => () => {}),
      resolvePermission: vi.fn(async () => {}),
      queuePrompt: vi.fn(async () => {
        setTimeout(() => {
          emit({ kind: 'turn_start', turnId: 't' });
          emit({ kind: 'turn_end', turnId: 't', stopReason: 'end_turn' });
        }, 0);
        return ok({ turnId: null });
      }),
    };
    const recordRun = vi.fn(async () => ok(null));
    const o = createOrchestrator({
      acp,
      rigTools: async () => ({ type: 'http', name: 'rig', url: 'http://127.0.0.1/mcp', headers: [] }) as never,
      whoami: async () => ok({ id: 'usr_me' }),
      cwd: async () => '/tmp/orch',
      newConversationId: () => 'orchestrator-1',
      state: async () => ok(state()),
      sources: async () => [],
      recordRun,
      issueTurn: () => 'turn_1',
      now: () => NOW,
    });
    const [a, b] = await Promise.all([o.run('schedule'), o.run('asked')]);
    expect(a.success && b.success && a.data.runId === b.data.runId).toBe(true);
    const second = await o.run('schedule');
    expect(second.success).toBe(true);
    expect(acp.startSession).toHaveBeenCalledTimes(1);
    expect(acp.startSession).toHaveBeenCalledWith(expect.objectContaining({ systemPromptAppend: expect.stringContaining('You are Rig, working in the background for Dylan Bourgeois.') }));
    expect((acp.startSession.mock.calls as unknown as [Record<string, unknown>][])[0]![0]).not.toHaveProperty('model');
    expect(acp.queuePrompt).toHaveBeenCalledTimes(2);
    // Started, then ended without a note: the cursors stay where they were.
    expect(recordRun).toHaveBeenCalledWith(expect.stringMatching(/^run_/), 'schedule', expect.objectContaining({ read: [{ source: 'slack', until: '2026-10-23T11:58:00Z' }], summary: expect.stringMatching(/^The run ended without a note\./) }));
  });
});
