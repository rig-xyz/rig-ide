import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { insideSpace, RoomSeesFilter, type FilteredEvent } from './trace-privacy';

const ROOT = '/Users/alice/Rig/launch';

type Raw = { kind: string; payload: Record<string, unknown> };

/**
 * One turn with every leak case the trace-privacy spike found or planted:
 * a connector returning someone's meeting transcript (Granola, the space's
 * own and a claude.ai global connector, and Codex's shape), a secret in a
 * command's output, private thinking, a file read outside the space,
 * narration between steps, an approval whose option names carry the
 * command, the dollar cost, Codex's echo of the hidden prompt, and an event
 * kind nobody knows yet. Plus the work the room should still see: the plan,
 * an edit to a space file, and the final answer.
 */
function leakyTurn(): Raw[] {
  const msg = (messageId: string, text: string) => ({
    kind: 'agent_message_chunk',
    payload: { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } },
  });
  return [
    { kind: 'run_privacy', payload: { level: 'steps' } },
    { kind: 'run_model', payload: { model: 'claude-opus-4-7' } },
    { kind: 'session_info_update', payload: { title: '<rig_space_context>room transcript SECRET_ECHO</rig_space_context>' } },
    {
      kind: 'plan',
      payload: {
        sessionUpdate: 'plan',
        entries: [
          { content: 'Check the board notes', status: 'completed', priority: 'high' },
          { content: 'Write the launch plan', status: 'in_progress' },
        ],
      },
    },
    { kind: 'agent_thought_chunk', payload: { content: { type: 'text', text: 'THOUGHT: Bob may take leave in May' } } },
    msg('m1', 'NARRATION: let me check ~/.aws first'),
    // The space's Granola connector: its result is a colleague's meeting.
    {
      kind: 'tool_call',
      payload: {
        sessionUpdate: 'tool_call',
        toolCallId: 'g1',
        kind: 'other',
        title: 'mcp__granola__list_meetings',
        status: 'pending',
        rawInput: { query: 'QUERY_board salary' },
        _meta: { claudeCode: { toolName: 'mcp__granola__list_meetings' } },
      },
    },
    {
      kind: 'tool_call_update',
      payload: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'g1',
        status: 'completed',
        rawOutput: 'GRANOLA_OUT: Bob asked for 180k',
        content: [{ type: 'content', content: { type: 'text', text: 'GRANOLA_OUT: Bob asked for 180k' } }],
        _meta: { claudeCode: { toolName: 'mcp__granola__list_meetings', toolResponse: [{ text: 'GRANOLA_DUP' }] } },
      },
    },
    // The agent's own claude.ai Linear: another organisation's issues.
    {
      kind: 'tool_call',
      payload: {
        sessionUpdate: 'tool_call',
        toolCallId: 'l1',
        kind: 'other',
        title: 'mcp__claude_ai_Linear__list_issues',
        name: 'mcp__claude_ai_Linear__list_issues',
        status: 'completed',
        rawOutput: 'LINEAR_OUT: OTHER-ORG-42 layoffs plan',
      },
    },
    // Codex's shape for a connector call.
    {
      kind: 'tool_call',
      payload: {
        sessionUpdate: 'tool_call',
        toolCallId: 'c1',
        kind: 'other',
        title: 'mcp.granola.get_transcript',
        status: 'completed',
        rawInput: { server: 'granola', tool: 'get_transcript', arguments: { id: 'CODEX_ARG_meeting_7' } },
        content: [{ type: 'content', content: { type: 'text', text: 'CODEX_OUT: transcript' } }],
      },
    },
    // A secret in a command's output, and the raw command as the title.
    {
      kind: 'tool_call',
      payload: {
        sessionUpdate: 'tool_call',
        toolCallId: 'b1',
        kind: 'execute',
        title: 'cat /Users/alice/.aws/credentials',
        status: 'completed',
        rawInput: { command: 'cat /Users/alice/.aws/credentials' },
        rawOutput: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI',
        _meta: { claudeCode: { toolName: 'Bash' }, terminal_output_delta: { data: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI' } },
      },
    },
    // A file outside the space's folder.
    {
      kind: 'tool_call',
      payload: {
        sessionUpdate: 'tool_call',
        toolCallId: 'r1',
        kind: 'read',
        title: 'Read /Users/alice/Documents/offer-letter.md',
        status: 'completed',
        locations: [{ path: '/Users/alice/Documents/offer-letter.md' }],
        rawInput: { file_path: '/Users/alice/Documents/offer-letter.md' },
        content: [{ type: 'content', content: { type: 'text', text: 'OFFER_TEXT: base salary' } }],
        _meta: { claudeCode: { toolName: 'Read' } },
      },
    },
    // A path that climbs out of the space is outside too.
    {
      kind: 'tool_call',
      payload: {
        sessionUpdate: 'tool_call',
        toolCallId: 'r2',
        kind: 'read',
        title: 'Read ../../.ssh/id_rsa',
        status: 'completed',
        locations: [{ path: `${ROOT}/../../.ssh/id_rsa` }],
        _meta: { claudeCode: { toolName: 'Read' } },
      },
    },
    // Work on the space's own files.
    {
      kind: 'tool_call',
      payload: {
        sessionUpdate: 'tool_call',
        toolCallId: 'r3',
        kind: 'read',
        title: 'Read File',
        status: 'pending',
        _meta: { claudeCode: { toolName: 'Read' } },
      },
    },
    {
      kind: 'tool_call_update',
      payload: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'r3',
        status: 'completed',
        locations: [{ path: `${ROOT}/notes/pricing.md` }],
        content: [{ type: 'content', content: { type: 'text', text: 'READ_OUT: pricing contents' } }],
      },
    },
    {
      kind: 'tool_call',
      payload: {
        sessionUpdate: 'tool_call',
        toolCallId: 'e1',
        kind: 'edit',
        title: 'Write plan.md',
        status: 'completed',
        locations: [{ path: `${ROOT}/plan.md` }],
        rawInput: { file_path: `${ROOT}/plan.md`, content: '# Launch plan' },
        content: [{ type: 'diff', path: `${ROOT}/plan.md`, oldText: null, newText: '# Launch plan\n\nFriday.' }],
        _meta: { claudeCode: { toolName: 'Write' } },
      },
    },
    {
      kind: 'permission_requested',
      payload: {
        requestId: 'p1',
        toolCall: { toolCallId: 'b1', title: 'cat /Users/alice/.aws/credentials' },
        options: [
          { optionId: 'allow', name: 'OPTION_Yes, and always allow cat /Users/alice/.aws/*', kind: 'allow_always' },
          { optionId: 'no', name: 'No', kind: 'reject_once' },
        ],
        pubTs: 1,
      },
    },
    { kind: 'permission_decided', payload: { requestId: 'p1', toolCallId: 'b1', optionId: 'allow', outcome: 'allowed' } },
    { kind: 'usage_update', payload: { sessionUpdate: 'usage_update', used: 1200, size: 200000, cost: { amount: 0.42, currency: 'USD' } } },
    { kind: 'future_kind', payload: { secret: 'FUTURE_SECRET' } },
    { kind: 'user_message_chunk', payload: { content: { type: 'text', text: 'USER_ECHO' } } },
    msg('m2', 'The launch '),
    msg('m2', 'is on Friday.'),
    { kind: 'turn_ended', payload: { status: 'done' } },
  ];
}

const LEAKS = [
  'SECRET_ECHO',
  'THOUGHT',
  'NARRATION',
  'QUERY_board',
  'GRANOLA_OUT',
  'GRANOLA_DUP',
  'LINEAR_OUT',
  'CODEX_ARG',
  'CODEX_OUT',
  'AWS_SECRET',
  '.aws',
  'offer-letter',
  'OFFER_TEXT',
  'id_rsa',
  'READ_OUT',
  'OPTION_',
  'FUTURE_SECRET',
  'USER_ECHO',
  '/Users/alice',
  '0.42',
];

function run(level: 'answer' | 'steps' | 'everything', events: Raw[] = leakyTurn()): FilteredEvent[] {
  const filter = new RoomSeesFilter(level, ROOT);
  return events.flatMap((e) => filter.filter(e.kind, e.payload));
}

const byId = (out: FilteredEvent[], id: string) =>
  out.filter((e) => e.kind.startsWith('tool_call') && e.payload.toolCallId === id).map((e) => e.payload);

describe('insideSpace', () => {
  it('gives a space-relative path only for paths inside the folder', () => {
    expect(insideSpace(`${ROOT}/notes/a.md`, ROOT)).toBe('notes/a.md');
    expect(insideSpace('notes/a.md', ROOT)).toBe('notes/a.md');
    expect(insideSpace(ROOT, ROOT)).toBe('.');
    expect(insideSpace('/Users/alice/Rig/launch-other/a.md', ROOT)).toBeNull();
    expect(insideSpace(`${ROOT}/../x.md`, ROOT)).toBeNull();
    expect(insideSpace('../x.md', ROOT)).toBeNull();
    expect(insideSpace('~/x.md', ROOT)).toBeNull();
  });
});

describe('RoomSeesFilter at Steps', () => {
  const out = run('steps');
  const text = JSON.stringify(out);

  it('uploads none of the leak cases', () => {
    for (const leak of LEAKS) expect(text, leak).not.toContain(leak);
  });

  it('labels a connector step by its name and marks it private (the Granola case, space and global connectors, Codex)', () => {
    expect(byId(out, 'g1')).toEqual([
      { sessionUpdate: 'tool_call', toolCallId: 'g1', kind: 'other', status: 'pending', title: 'mcp__granola__list_meetings', private: true },
      { sessionUpdate: 'tool_call_update', toolCallId: 'g1', kind: 'other', status: 'completed', title: 'mcp__granola__list_meetings', private: true },
    ]);
    expect(byId(out, 'l1')[0]).toMatchObject({ title: 'mcp__claude_ai_Linear__list_issues', private: true });
    expect(byId(out, 'c1')[0]).toMatchObject({ title: 'mcp__granola__get_transcript', private: true });
  });

  it('shows a command as "Ran a command", not its text or output', () => {
    expect(byId(out, 'b1')).toEqual([
      { sessionUpdate: 'tool_call', toolCallId: 'b1', kind: 'execute', status: 'completed', title: 'Ran a command' },
    ]);
  });

  it('marks a file read outside the space private, with no path', () => {
    expect(byId(out, 'r1')).toEqual([
      { sessionUpdate: 'tool_call', toolCallId: 'r1', kind: 'read', status: 'completed', title: 'Read a file', private: true },
    ]);
    expect(byId(out, 'r2')[0]).toMatchObject({ title: 'Read a file', private: true });
  });

  it("shares work on the space's own files: the relative path, and an edit's diff", () => {
    expect(byId(out, 'r3').at(-1)).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'r3',
      kind: 'read',
      status: 'completed',
      title: 'Read notes/pricing.md',
      locations: [{ path: 'notes/pricing.md' }],
    });
    expect(byId(out, 'e1')[0]).toMatchObject({
      title: 'Edited plan.md',
      locations: [{ path: 'plan.md' }],
      content: [{ type: 'diff', path: 'plan.md', oldText: null, newText: '# Launch plan\n\nFriday.' }],
    });
    expect(byId(out, 'e1')[0]).not.toHaveProperty('private');
  });

  it('shares the plan, but not thinking', () => {
    expect(out.find((e) => e.kind === 'plan')?.payload).toEqual({
      sessionUpdate: 'plan',
      entries: [
        { content: 'Check the board notes', status: 'completed' },
        { content: 'Write the launch plan', status: 'in_progress' },
      ],
    });
    expect(out.some((e) => e.kind === 'agent_thought_chunk')).toBe(false);
  });

  it('holds the answer back and sends only the final message, whole, before the turn ends', () => {
    const kinds = out.map((e) => e.kind);
    const answers = out.filter((e) => e.kind === 'agent_message_chunk');
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({
      payload: { messageId: 'm2', content: { type: 'text', text: 'The launch is on Friday.' } },
      ownBatch: true,
    });
    expect(kinds.indexOf('agent_message_chunk')).toBe(kinds.length - 2);
    expect(out.at(-1)).toEqual({ kind: 'turn_ended', payload: { status: 'done' } });
  });

  it("keeps a turn's reactions on its end: they're on the message for everyone already", () => {
    const filter = new RoomSeesFilter('answer', '/rigs/one');
    expect(filter.filter('turn_ended', { status: 'done', reacted: ['👍', { who: 'x' }], extra: 1 }).at(-1)).toEqual({
      kind: 'turn_ended',
      payload: { status: 'done', reacted: ['👍'] },
    });
  });

  it('redacts an approval to its step label: no command, no option names', () => {
    expect(out.find((e) => e.kind === 'permission_requested')?.payload).toEqual({
      requestId: 'p1',
      pubTs: 1,
      private: true,
      toolCall: { toolCallId: 'b1', title: 'Ran a command' },
      options: [],
    });
    expect(out.find((e) => e.kind === 'permission_decided')?.payload).toMatchObject({ outcome: 'allowed' });
  });

  it('keeps context use but not its dollar cost; drops unknown kinds, echoes and session titles', () => {
    expect(out.find((e) => e.kind === 'usage_update')?.payload).toEqual({ sessionUpdate: 'usage_update', used: 1200, size: 200000 });
    for (const kind of ['future_kind', 'user_message_chunk', 'session_info_update']) {
      expect(out.some((e) => e.kind === kind)).toBe(false);
    }
    expect(out.find((e) => e.kind === 'run_privacy')?.payload).toEqual({ level: 'steps' });
  });

  it('splits a long answer into pieces the relay stores whole', () => {
    const long = 'x'.repeat(8000);
    const pieces = run('steps', [
      { kind: 'agent_message_chunk', payload: { messageId: 'm', content: { type: 'text', text: long } } },
      { kind: 'turn_ended', payload: { status: 'done' } },
    ]).filter((e) => e.kind === 'agent_message_chunk');
    expect(pieces.length).toBe(3);
    expect(pieces.every((p) => p.ownBatch)).toBe(true);
    expect(pieces.map((p) => (p.payload.content as { text: string }).text).join('')).toBe(long);
  });
});

describe('RoomSeesFilter at Answer', () => {
  const out = run('answer');
  const text = JSON.stringify(out);

  it('uploads none of the leak cases, nor any step label or the plan', () => {
    for (const leak of [...LEAKS, 'granola', 'Linear', 'Ran a command', 'pricing', 'plan.md', 'Check the board notes']) {
      expect(text, leak).not.toContain(leak);
    }
  });

  it('sends only the step count, the approval outcome, how it ended and the answer', () => {
    expect(out.map((e) => e.kind)).toEqual([
      'run_privacy',
      'run_model',
      ...Array(8).fill('private_progress'),
      'permission_requested',
      'permission_decided',
      'agent_message_chunk',
      'private_progress',
      'turn_ended',
    ]);
    expect(out.filter((e) => e.kind === 'private_progress').map((e) => e.payload)).toEqual([
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((steps) => ({ steps })),
      { steps: 8, final: true },
    ]);
    expect(out.find((e) => e.kind === 'permission_requested')?.payload).toEqual({
      requestId: 'p1',
      pubTs: 1,
      private: true,
      toolCall: { toolCallId: 'b1', title: null },
      options: [],
    });
    expect(out.find((e) => e.kind === 'agent_message_chunk')?.payload).toMatchObject({
      content: { text: 'The launch is on Friday.' },
    });
  });
});

describe('RoomSeesFilter at Everything', () => {
  it('passes every event through as it is (today’s behaviour)', () => {
    const events = leakyTurn();
    expect(run('everything', events)).toEqual(events);
  });
});

describe('RoomSeesFilter over the recorded runs', () => {
  const dir = join(__dirname, '../../../renderer/features/spaces/fixtures/session-events');
  /** Every string an adapter wrote that the room shouldn't get below Everything: inputs, outputs, thinking, raw titles, option names. */
  function privateStrings(events: Raw[]): string[] {
    const found = new Set<string>();
    const collect = (value: unknown) => {
      if (typeof value === 'string') {
        if (value.length >= 12) found.add(value);
      } else if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === 'object') Object.values(value).forEach(collect);
    };
    for (const e of events) {
      const p = e.payload;
      if (e.kind === 'tool_call' || e.kind === 'tool_call_update') {
        collect(p.rawOutput);
        const meta = p._meta as Record<string, Record<string, unknown> | undefined> | undefined;
        collect(meta?.claudeCode?.toolResponse);
        collect(meta?.terminal_output_delta);
        if (p.kind !== 'edit') collect(p.rawInput);
        if (p.kind !== 'edit' && Array.isArray(p.content)) collect(p.content);
        // A raw command, or a title naming a path (an in-space "Read plan.md" is the label itself).
        if (typeof p.title === 'string' && (p.kind === 'execute' || p.title.includes('/'))) found.add(p.title);
      }
      if (e.kind === 'agent_thought_chunk') collect(p.content);
      if (e.kind === 'permission_requested') collect((p.options as unknown[] | undefined)?.map((o) => (o as { name?: unknown }).name));
    }
    // Tool call ids travel on purpose (they tie a step's updates together).
    const ids = new Set(events.map((e) => e.payload.toolCallId));
    return [...found].filter((s) => !ids.has(s));
  }

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    it(`${file}: nothing private reaches the relay at Steps or Answer`, () => {
      const events = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Raw[];
      // The folder these runs ran in, as the edits' paths report it.
      const root = '/Users/dtsbourg/Code/tap-spike-sessions/.spike/runs/' + file.replace(/\.json$/, '');
      const secrets = privateStrings(events);
      for (const level of ['steps', 'answer'] as const) {
        const filter = new RoomSeesFilter(level, root);
        const out = JSON.stringify(events.flatMap((e) => filter.filter(e.kind, e.payload)));
        for (const secret of secrets) expect(out, `${level}: ${secret.slice(0, 60)}`).not.toContain(secret);
        expect(out).not.toContain('/Users/dtsbourg');
      }
    });
  }
});
