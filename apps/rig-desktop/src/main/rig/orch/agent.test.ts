import type { AcpPermissionRequest } from '@emdash/core/acp';
import { err, ok } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import type { OrchAgentState } from '../feed/relay';
import type { RawSessionEvent } from '../spaces/dispatch';
import type { OrchProgressEvent } from '@shared/rig/orch-progress';
import { AGENT_DENIED_TOOLS, agentPermission, buildPacket, createOrchestrator, FIRST_RUN } from './agent';
import { createTurnGate } from './turns';

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
  counts: { open: 12, visible: 6, queued: 9, following: 20, untopiced: 4 },
  bare: [{ ref: 'sit_3', title: 'Old pipeline card' }],
  ...over,
});

describe('the background orchestrator', () => {
  it('builds a short packet: who, rules, and where to look', () => {
    const packet = buildPacket({ runId: 'run_x', now: NOW, trigger: 'schedule', state: state(), sources: [{ connector: 'Slack', what: 'your DMs' }, { connector: 'Linear', what: 'Ulys issues' }] });
    expect(packet).toContain('<run id="run_x" now="2026-10-23T13:00:00.000Z" trigger="schedule" budget="40 lookups"/>');
    // A run is never the person asking: no user_turn_id for rig_start's gate.
    expect(packet).not.toContain('user_turn_id');
    expect(packet).toContain('CTO of Ulys');
    expect(packet).toContain('rule_1 "Investors come to me first."');
    expect(packet).toContain('slack: your DMs, since 2026-10-23T11:58:00Z');
    // A source with no cursor yet reads its last three days, with a bigger budget.
    expect(packet).toContain('linear: Ulys issues, never read: read since 2026-10-20T13:00:00.000Z');
    expect(packet).toContain('First read of linear: search the connector itself for the last three days');
    expect(packet).toContain('Following: 20 situations, 4 open with no topic: look them over');
    expect(packet).toContain('budget="40 lookups"');
    expect(packet).toContain('Visible with no card written (your owner sees nothing there): sit_3 "Old pipeline card"');
    expect(packet).toContain('name each source exactly as above (slack, linear)');
    expect(packet).toContain('Due now: sit_1 "Christopher asks for approval on #343"');
    expect(packet).toContain('oev_9 session for sit_2: Traced ULY-523');
    expect(packet).toContain('Open: 12 situations, 6 cards visible, 9 queued');
  });

  it("allows its own Rig tools and read-only lookups, and refuses everything else", () => {
    expect(agentPermission(perm('mcp__rig__rig_feed'))).toBe('yes');
    expect(agentPermission(perm('mcp__rig__rig_github'))).toBe('yes');
    expect(agentPermission(perm('mcp__rig__rig_start'))).toBe('no');
    expect(agentPermission(perm('mcp__rig__rig_chat_read'))).toBe('no');
    expect(agentPermission(perm('mcp__claude_ai_Slack__slack_read_thread'))).toBe('yes');
    expect(agentPermission(perm('mcp__claude_ai_Slack__slack_send_message'))).toBe('no');
    // GitHub goes through rig_github: no shell, even for a gh read.
    expect(agentPermission(perm('gh pr view 343 --repo Ulysholdings/mobile-ios-v2', { kind: 'execute-tool-call', command: 'gh pr view 343 --repo Ulysholdings/mobile-ios-v2' }))).toBe('no');
    expect(agentPermission(perm('gh pr merge 343', { kind: 'execute-tool-call', command: 'gh pr merge 343' }))).toBe('no');
    // A read verb inside a write isn't a read.
    expect(agentPermission(perm('mcp__claude_ai_Slack__slack_mark_read'))).toBe('no');
    expect(agentPermission(perm('mcp__claude_ai_Linear__get_or_create_label'))).toBe('no');
    // What its own settings would allow (the web, other servers) still comes here, and is refused.
    expect(agentPermission(perm('WebFetch'))).toBe('no');
    expect(agentPermission(perm('mcp__my_local_server__read_file'))).toBe('no');
  });

  it("logs which tool it refused, never the call's title or input", async () => {
    let ask: (r: AcpPermissionRequest) => void = () => {};
    const info = vi.fn();
    const o = createOrchestrator({
      acp: {
        startSession: vi.fn(async () => ok({ sessionId: 's' })),
        setConfig: vi.fn(async () => ok(undefined)),
        cancelTurn: vi.fn(async () => {}),
        stopSession: vi.fn(async () => {}),
        subscribeRaw: vi.fn(async () => () => {}),
        subscribePendingPermissions: vi.fn(async (_id: string, on: (r: AcpPermissionRequest) => void) => ((ask = on), () => {})),
        resolvePermission: vi.fn(async () => {}),
        queuePrompt: vi.fn(async () => ok({ turnId: null })),
      },
      rigTools: async () => ({ type: 'http', name: 'rig', url: 'http://127.0.0.1/mcp', headers: [] }) as never,
      whoami: async () => ok({ id: 'usr_me' }),
      cwd: async () => '/tmp/orch',
      newConversationId: () => 'orchestrator-1',
      state: async () => ok(state()),
      sources: async () => [],
      recordRun: async () => ok(null),
      now: () => NOW,
      turnTimeoutMs: 5,
      log: { info, warn: vi.fn() },
    });
    await o.run('schedule');
    ask(perm('mcp__claude_ai_Slack__slack_send_message', { rawInput: { message: 'the board deck is in /private' } }));
    ask(perm('Fetch https://example.com/?q=salaries', { kind: 'fetch' }));
    const refused = info.mock.calls.filter((c) => c[0] === 'Rig orchestrator: refused a tool call').map((c) => c[1]);
    expect(refused).toEqual([{ tool: 'mcp__claude_ai_Slack__slack_send_message' }, { tool: 'fetch' }]);
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/board deck|salaries/);
  });

  it('runs one turn on a session it keeps, records the run, and writes a note when Claude left none', async () => {
    let emit: (e: RawSessionEvent) => void = () => {};
    const acp = {
      startSession: vi.fn(async () => ok({ sessionId: 's' })),
      setConfig: vi.fn(async () => ok(undefined)),
      cancelTurn: vi.fn(async () => {}),
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
      now: () => NOW,
    });
    const [a, b] = await Promise.all([o.run('schedule'), o.run('asked')]);
    expect(a.success && b.success && a.data.runId === b.data.runId).toBe(true);
    const second = await o.run('schedule');
    expect(second.success).toBe(true);
    expect(acp.startSession).toHaveBeenCalledTimes(1);
    expect(acp.startSession).toHaveBeenCalledWith(expect.objectContaining({ systemPromptAppend: expect.stringContaining('You are Rig, working in the background for Dylan Bourgeois.') }));
    expect((acp.startSession.mock.calls as unknown as [Record<string, unknown>][])[0]![0]).not.toHaveProperty('model');
    // Locked down in code: no shell, file writes, web, subagents or rig_start, no bypass, none of the person's settings allow rules, and Ask first.
    expect(acp.startSession).toHaveBeenCalledWith(expect.objectContaining({ disallowedTools: AGENT_DENIED_TOOLS, noBypassPermissions: true, appPermissionsOnly: true }));
    expect(AGENT_DENIED_TOOLS).toEqual(expect.arrayContaining(['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'mcp__rig__rig_start']));
    expect(acp.setConfig).toHaveBeenCalledWith('orchestrator-1', { mode: 'default' });
    expect(acp.queuePrompt).toHaveBeenCalledTimes(2);
    // Started, then ended without a note: the cursors stay where they were.
    expect(recordRun).toHaveBeenCalledWith(expect.stringMatching(/^run_/), 'schedule', expect.objectContaining({ read: [{ source: 'slack', until: '2026-10-23T11:58:00Z' }], summary: expect.stringMatching(/^The run ended without a note\./) }));
  });

  it("doesn't run when its session can't be put in Ask first", async () => {
    const acp = {
      startSession: vi.fn(async () => ok({ sessionId: 's' })),
      setConfig: vi.fn(async () => err('no such mode')),
      cancelTurn: vi.fn(async () => {}),
      stopSession: vi.fn(async () => {}),
      subscribeRaw: vi.fn(async () => () => {}),
      subscribePendingPermissions: vi.fn(async () => () => {}),
      resolvePermission: vi.fn(async () => {}),
      queuePrompt: vi.fn(async () => ok({ turnId: null })),
    };
    const o = createOrchestrator({
      acp,
      rigTools: async () => ({ type: 'http', name: 'rig', url: 'http://127.0.0.1/mcp', headers: [] }) as never,
      whoami: async () => ok({ id: 'usr_me' }),
      cwd: async () => '/tmp/orch',
      newConversationId: () => 'orchestrator-1',
      state: async () => ok(state()),
      sources: async () => [],
      recordRun: async () => ok(null),
      now: () => NOW,
    });
    const r = await o.run('schedule');
    expect(r.success).toBe(false);
    expect(acp.queuePrompt).not.toHaveBeenCalled();
    expect(acp.stopSession).toHaveBeenCalledWith('orchestrator-1');
  });
});

describe('the first run', () => {
  /** A session whose turns run the given tool calls, one script per turn. */
  function harness(turns: Array<Array<{ id: string; name: string; input: Record<string, unknown>; fail?: string }>>, extra: Partial<Parameters<typeof createOrchestrator>[0]> = {}) {
    let emit: (e: RawSessionEvent) => void = () => {};
    let turn = 0;
    const prompts: string[] = [];
    const acp = {
      startSession: vi.fn(async () => ok({ sessionId: 's' })),
      setConfig: vi.fn(async () => ok(undefined)),
      cancelTurn: vi.fn(async () => {}),
      readConfig: vi.fn(async () => ({ model: { selected: 'default', options: [] }, effort: { selected: 'default', options: [] }, mode: null })),
      stopSession: vi.fn(async () => {}),
      subscribeRaw: vi.fn(async (_id: string, on: (e: RawSessionEvent) => void) => ((emit = on), () => {})),
      subscribePendingPermissions: vi.fn(async () => () => {}),
      resolvePermission: vi.fn(async () => {}),
      queuePrompt: vi.fn(async (_id: string, prompt: string) => {
        prompts.push(prompt);
        const calls = turns[turn++] ?? [];
        setTimeout(() => {
          emit({ kind: 'turn_start', turnId: 't' });
          for (const c of calls) {
            emit({ kind: 'acp_update', update: { sessionUpdate: 'tool_call', toolCallId: c.id, name: c.name, status: 'pending', rawInput: c.input } } as never);
            emit({ kind: 'acp_update', update: { sessionUpdate: 'tool_call_update', toolCallId: c.id, ...(c.fail ? { status: 'failed', content: [{ type: 'content', content: { type: 'text', text: c.fail } }] } : { status: 'completed' }) } } as never);
          }
          emit({ kind: 'turn_end', turnId: 't', stopReason: 'end_turn' });
        }, 0);
        return ok({ turnId: null });
      }),
    };
    const progress: OrchProgressEvent[] = [];
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
      now: () => NOW,
      onProgress: (e) => progress.push(e),
      ...extra,
    });
    return { o, prompts, progress, recordRun, acp };
  }
  const put = (id: string) => ({ id, name: 'mcp__rig__rig_feed', input: { op: 'put', ref: `sit_${id}` } });
  const read = (id: string) => ({ id, name: 'mcp__claude_ai_Slack__slack_read_channel', input: { channel_name: 'eng' } });

  it('reads in two passes, the first card first, and says so as it goes', async () => {
    const h = harness([[read('a'), put('p1')], [read('b')]]);
    const r = await h.o.run('first', FIRST_RUN);
    expect(r.success && r.data.cards).toBe(1);
    expect(h.prompts).toHaveLength(2);
    expect(h.prompts[0]).toContain('Pass 1 of 2, 12 lookups');
    expect(h.prompts[0]).toContain('Step 3: put the card for the most pressing thing');
    expect(h.prompts[0]).toContain('budget="12 lookups"');
    expect(h.prompts[1]).toContain('Pass 2 of 2, 40 lookups');
    // Each pass is its own run row, recorded with its pass.
    expect(h.recordRun).toHaveBeenCalledWith(expect.stringMatching(/^run_/), 'first', undefined, 1);
    expect(h.recordRun).toHaveBeenCalledWith(expect.stringMatching(/^run_/), 'first', undefined, 2);
    // A line at once, before the session is even up; then the reads, the card, the end.
    const kinds = h.progress.map((e) => (e.kind === 'line' ? `line:${e.line.label}:${e.line.status}` : e.kind));
    expect(kinds[0]).toBe('start');
    expect(kinds[1]).toBe('line:Looking up what Rig already knows:running');
    expect(kinds).toContain('card');
    expect(kinds).toContain('line:Checking #eng:done');
    expect(kinds.at(-1)).toBe('end');
    expect(new Set(h.progress.map((e) => e.run)).size).toBe(1);
  });

  it('widens to two weeks once when the first pass finds nothing', async () => {
    const h = harness([[read('a')], [read('b'), put('p1')], [read('c')]]);
    const r = await h.o.run('first', FIRST_RUN);
    expect(r.success && r.data.cards).toBe(1);
    expect(h.prompts).toHaveLength(3);
    expect(h.prompts[1]).toContain('read the last 14 days once instead');
    expect(h.prompts[2]).toContain('keep reading the rest of the last 14 days');
    expect(h.progress.filter((e) => e.kind === 'pass').map((e) => (e.kind === 'pass' ? e.lookbackDays : 0))).toEqual([3, 14, 14]);
  });

  it('runs a pass on another model when asked, then goes back to the session\'s own', async () => {
    const h = harness([[put('p1')], [read('b')]]);
    await h.o.run('first', { ...FIRST_RUN, passes: [{ lookups: 12, goal: 'first card', model: 'sonnet' }, { lookups: 40 }] });
    const changes = (h.acp.setConfig.mock.calls as unknown as [string, Record<string, string>][]).map((c) => c[1]).filter((c) => c.model || c.effort);
    expect(changes).toEqual([{ model: 'sonnet', effort: 'default' }, { model: 'default' }]);
  });

  it('ends a pass as soon as its note is in, without waiting for a closing message', async () => {
    const note = { id: 'n1', name: 'mcp__rig__rig_run_note', input: { run_id: 'x', summary: 'done', read: [], changed: [], left: [] } };
    const h = harness([[put('p1'), note], [note]]);
    await h.o.run('first', FIRST_RUN);
    await vi.waitFor(() => expect(h.acp.cancelTurn).toHaveBeenCalledTimes(2));
  });

  it("puts what Rig holds in the packet: the Feed, open situations and GitHub's asks", async () => {
    const snapshot = async () => ({ feed: ['sit_1 [visible] "Review #212"'], situations: ['sit_1 "Rate limits PR" · feed visible'], github: ['github:acme/api#212 "Rate limits" by tom'] });
    const h = harness([[put('p1')], []], { snapshot });
    await h.o.run('first', FIRST_RUN);
    expect(h.prompts[0]).toContain('## Your Feed now (1)\nsit_1 [visible] "Review #212"');
    expect(h.prompts[0]).toContain('## Open situations, newest first (1 of 12)');
    expect(h.prompts[0]).toContain('github:acme/api#212 "Rate limits" by tom');
  });

  it('starts one first run however often it is asked, and hands a late caller its events so far', async () => {
    const h = harness([[read('a'), put('p1')], [read('b')]]);
    // Asked again while it runs: right away, and once its first pass has begun.
    let late: ReturnType<typeof h.o.startFirst> | null = null;
    const push = h.progress.push.bind(h.progress);
    h.progress.push = (...e: OrchProgressEvent[]) => {
      const n = push(...e);
      if (!late && e[0]?.kind === 'pass') late = h.o.startFirst(FIRST_RUN);
      return n;
    };
    const one = h.o.startFirst(FIRST_RUN);
    const two = h.o.startFirst(FIRST_RUN);
    expect(one.joined).toBe(false);
    expect(two.joined).toBe(true);
    await one.done;
    expect(late!.joined).toBe(true);
    expect(late!.events[0]).toMatchObject({ kind: 'start', trigger: 'first', seq: 0 });
    expect(late!.events.map((e) => e.seq)).toEqual(late!.events.map((_, i) => i));
    // One run's worth of prompts, not two.
    expect(h.prompts).toHaveLength(2);
    expect(new Set(h.progress.map((e) => e.run)).size).toBe(1);
    // Once it has ended, asking again starts a new one.
    expect(h.o.startFirst(FIRST_RUN).joined).toBe(false);
  });

  it("shows a card already on the Feed as the first one when pass 1 puts none, and doesn't widen", async () => {
    const snapshot = async () => ({ feed: ['sit_q [queued] "Later"', 'sit_top [visible] "Review #212"'], situations: [] });
    const h = harness([[read('a')], [read('b')]], { snapshot });
    const r = await h.o.run('first', FIRST_RUN);
    expect(r.success && r.data.cards).toBe(1);
    expect(h.prompts).toHaveLength(2);
    expect(h.progress.filter((e) => e.kind === 'card')).toEqual([expect.objectContaining({ kind: 'card', ref: 'sit_top' })]);
    expect(h.prompts[1]).toContain('Pass 2 of 2, 40 lookups');
  });

  it('gives the first run a session of its own, so earlier runs never make it skip the reading', async () => {
    const h = harness([[read('a')], [read('b'), put('p1')], [read('c')]]);
    await h.o.run('schedule');
    await h.o.startFirst(FIRST_RUN).done;
    expect(h.acp.startSession).toHaveBeenCalledTimes(2);
    expect(h.acp.stopSession).toHaveBeenCalledTimes(1);
  });

  it('a regular run reads in one pass with the usual budget', async () => {
    const h = harness([[read('a')]]);
    await h.o.run('schedule');
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).not.toContain('## First read');
    expect(h.recordRun).toHaveBeenCalledWith(expect.stringMatching(/^run_/), 'schedule', undefined, undefined);
  });
});

describe('a catch-up for someone Rig has read for', () => {
  function harness(turns: Array<Array<{ id: string; name: string; input: Record<string, unknown>; fail?: string }>>, extra: Partial<Parameters<typeof createOrchestrator>[0]> = {}) {
    let emit: (e: RawSessionEvent) => void = () => {};
    let turn = 0;
    const prompts: string[] = [];
    const acp = {
      startSession: vi.fn(async () => ok({ sessionId: 's' })),
      setConfig: vi.fn(async () => ok(undefined)),
      cancelTurn: vi.fn(async () => {}),
      readConfig: vi.fn(async () => ({ model: { selected: 'default', options: [] }, effort: { selected: 'default', options: [] }, mode: null })),
      stopSession: vi.fn(async () => {}),
      subscribeRaw: vi.fn(async (_id: string, on: (e: RawSessionEvent) => void) => ((emit = on), () => {})),
      subscribePendingPermissions: vi.fn(async () => () => {}),
      resolvePermission: vi.fn(async () => {}),
      queuePrompt: vi.fn(async (_id: string, prompt: string) => {
        prompts.push(prompt);
        const calls = turns[turn++] ?? [];
        setTimeout(() => {
          emit({ kind: 'turn_start', turnId: 't' });
          for (const c of calls) {
            emit({ kind: 'acp_update', update: { sessionUpdate: 'tool_call', toolCallId: c.id, name: c.name, status: 'pending', rawInput: c.input } } as never);
            emit({ kind: 'acp_update', update: { sessionUpdate: 'tool_call_update', toolCallId: c.id, ...(c.fail ? { status: 'failed', content: [{ type: 'content', content: { type: 'text', text: c.fail } }] } : { status: 'completed' }) } } as never);
          }
          emit({ kind: 'turn_end', turnId: 't', stopReason: 'end_turn' });
        }, 0);
        return ok({ turnId: null });
      }),
    };
    const progress: OrchProgressEvent[] = [];
    const o = createOrchestrator({
      acp,
      rigTools: async () => ({ type: 'http', name: 'rig', url: 'http://127.0.0.1/mcp', headers: [] }) as never,
      whoami: async () => ok({ id: 'usr_me' }),
      cwd: async () => '/tmp/orch',
      newConversationId: () => 'orchestrator-1',
      state: async () => ok(state()),
      sources: async () => [],
      recordRun: vi.fn(async () => ok(null)),
      feedRefs: async () => ['sit_old'],
      now: () => NOW,
      onProgress: (e) => progress.push(e),
      ...extra,
    });
    return { o, prompts, progress };
  }
  const since = '2026-10-21T09:00:00.000Z';
  const put = (id: string, ref: string) => ({ id, name: 'mcp__rig__rig_feed', input: { op: 'put', ref } });
  const outcome = (id: string, ref: string) => ({ id, name: 'mcp__rig__rig_run_note', input: { run_id: 'x', outcome: { kind: 'for_you', ref, line: 'Still waiting on you' } } });

  it('reads since the last read, says so, never re-proposes what is on the Feed, and never widens', async () => {
    const h = harness([[], []]);
    await h.o.run('first', { ...FIRST_RUN, since });
    expect(h.progress[0]).toMatchObject({ kind: 'start', since });
    expect(h.prompts[0]).toContain(`find the one new thing since ${since}`);
    expect(h.prompts[0]).toContain('never put one of them again');
    expect(h.prompts[0]).not.toContain('A card already on the Feed counts');
    // Nothing new in pass 1 is a fine answer: no 14-day widening for a catch-up.
    expect(h.prompts).toHaveLength(2);
    expect(h.prompts[1]).toContain(`keep reading what came in since ${since}`);
  });

  it('marks cards and outcomes that were on the Feed before the run as not new', async () => {
    const h = harness([[put('a', 'sit_old'), put('b', 'sit_new'), outcome('c', 'sit_old')], []]);
    await h.o.run('first', { ...FIRST_RUN, since });
    const cards = h.progress.filter((e) => e.kind === 'card');
    expect(cards).toEqual([expect.objectContaining({ ref: 'sit_old', fresh: false }), expect.objectContaining({ ref: 'sit_new', fresh: true })]);
  });

  it('stops with the fix it needs: Rig signed out, or the relay out of reach', async () => {
    const signedOut = harness([[]], { state: async () => err({ message: 'Your Rig session expired.', problem: 'rig_signed_out' }) });
    await signedOut.o.run('schedule');
    expect(signedOut.progress.at(-1)).toMatchObject({ kind: 'end', ok: false, problem: 'rig_signed_out' });
    const away = harness([[]], { state: async () => err({ message: "Rig can't reach the server.", problem: 'relay_unreachable' }) });
    await away.o.run('schedule');
    expect(away.progress.at(-1)).toMatchObject({ kind: 'end', ok: false, problem: 'relay_unreachable' });
  });

  /** An orchestrator on a session whose ACP calls are these, and the progress it reports. */
  function onSession(acp: Record<string, unknown>, extra: Partial<Parameters<typeof createOrchestrator>[0]> = {}) {
    const progress: OrchProgressEvent[] = [];
    const o = createOrchestrator({
      acp: {
        startSession: vi.fn(async () => ok({ sessionId: 's' })),
        setConfig: vi.fn(async () => ok(undefined)),
        cancelTurn: vi.fn(async () => {}),
        stopSession: vi.fn(async () => {}),
        subscribeRaw: vi.fn(async () => () => {}),
        subscribePendingPermissions: vi.fn(async () => () => {}),
        resolvePermission: vi.fn(async () => {}),
        queuePrompt: vi.fn(async () => ok({ turnId: null })),
        ...acp,
      } as never,
      rigTools: async () => ({ type: 'http', name: 'rig', url: 'http://127.0.0.1/mcp', headers: [] }) as never,
      whoami: async () => ok({ id: 'usr_me' }),
      cwd: async () => '/tmp/orch',
      newConversationId: () => 'orchestrator-x',
      state: async () => ok(state()),
      sources: async () => [],
      recordRun: vi.fn(async () => ok(null)),
      now: () => NOW,
      onProgress: (e) => progress.push(e),
      ...extra,
    });
    return { o, progress };
  }

  it('says Claude needs signing in when its session won’t start for want of a sign-in', async () => {
    const h = onSession({ startSession: vi.fn(async () => err('Invalid API key · Please run /login')) });
    await h.o.run('schedule');
    expect(h.progress.at(-1)).toMatchObject({ kind: 'end', ok: false, problem: 'agent_signed_out' });
  });

  it('says once when a connector needs reconnecting, and keeps reading', async () => {
    const lapsed = { id: 'x', name: 'mcp__claude_ai_Slack__slack_read_channel', input: { channel_name: 'eng' }, fail: 'Slack: invalid_auth, reconnect the connector' };
    const h = harness([[lapsed, { ...lapsed, id: 'y' }, { id: 'z', name: 'mcp__claude_ai_Linear__list_issues', input: {} }]]);
    const r = await h.o.run('schedule');
    expect(r.success).toBe(true);
    expect(h.progress.filter((e) => e.kind === 'problem')).toEqual([expect.objectContaining({ problem: 'connector_auth', connector: 'slack' })]);
  });

  it('a run that takes too long stops with Try again, and stops the turn too', async () => {
    // A turn that never ends.
    const cancelTurn = vi.fn(async () => {});
    const h = onSession({ cancelTurn }, { turnTimeoutMs: 5 });
    await h.o.run('schedule');
    expect(h.progress.at(-1)).toMatchObject({ kind: 'end', ok: false, problem: 'timeout' });
    expect(cancelTurn).toHaveBeenCalledWith('orchestrator-x');
  });

  it('ends with an `end` whatever throws after the start, so nothing waits on it forever', async () => {
    const thrown = onSession({}, { state: async () => Promise.reject(new Error('socket hang up')) });
    const r = await thrown.o.run('schedule');
    expect(r).toEqual(err('socket hang up'));
    expect(thrown.progress[0]).toMatchObject({ kind: 'start' });
    expect(thrown.progress.at(-1)).toMatchObject({ kind: 'end', ok: false, error: 'socket hang up' });
    // A pass that throws mid-run, too.
    const mid = onSession({ queuePrompt: vi.fn(async () => Promise.reject(new Error('runtime gone'))) });
    expect(await mid.o.run('schedule')).toEqual(err('runtime gone'));
    expect(mid.progress.filter((e) => e.kind === 'end')).toEqual([expect.objectContaining({ ok: false, error: 'runtime gone' })]);
  });

  it("goes back to the session's own model when a pass on another one fails", async () => {
    const setConfig = vi.fn(async (_id: string, _change: Record<string, string>) => ok(undefined));
    const h = onSession({
      setConfig,
      readConfig: vi.fn(async () => ({ model: { selected: 'opus', options: [] }, effort: { selected: 'high', options: [] }, mode: null })),
      queuePrompt: vi.fn(async () => err('Claude is overloaded')),
    });
    const r = await h.o.run('first', FIRST_RUN);
    expect(r.success).toBe(false);
    const models = setConfig.mock.calls.map((c) => c[1]).filter((c) => c.model || c.effort);
    expect(models).toEqual([{ model: 'sonnet', effort: 'high' }, { model: 'opus' }]);
  });

  it("logs a failed lookup and a pass by tool, ids and sizes: never what was read or Claude's words", async () => {
    const warn = vi.fn();
    const info = vi.fn();
    const failing = { id: 'x', name: 'mcp__claude_ai_Slack__slack_read_channel', input: {}, fail: 'channel #board-comp: Peter earns 240k' };
    const h = harness([[failing]], { log: { info, warn } });
    await h.o.run('schedule');
    const lookup = warn.mock.calls.find((c) => c[0] === 'Rig orchestrator: a lookup failed')![1];
    expect(lookup).toEqual({ pass: undefined, id: 'x', tool: 'mcp__claude_ai_Slack__slack_read_channel', length: expect.any(Number) });
    const pass = info.mock.calls.find((c) => c[0] === 'Rig orchestrator: pass ended')![1];
    expect(pass).not.toHaveProperty('said');
    expect(JSON.stringify([warn.mock.calls, info.mock.calls])).not.toContain('240k');
  });
});

describe('the user_turn_id gate', () => {
  it("passes the person's own message or click, and nothing else", () => {
    let t = 0;
    const gate = createTurnGate({ now: () => t, ttlMs: 1000 });
    expect(gate.fresh(gate.issue('click'))).toBe(true);
    expect(gate.fresh(gate.issue('chat'))).toBe(true);
    // An origin that isn't the person's (a background run) never passes, even if one were issued.
    expect(gate.fresh(gate.issue('run' as never))).toBe(false);
    expect(gate.fresh('turn_made_up')).toBe(false);
    const old = gate.issue('click');
    t = 2000;
    expect(gate.fresh(old)).toBe(false);
  });
});
