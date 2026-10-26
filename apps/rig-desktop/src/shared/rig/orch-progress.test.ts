import { describe, expect, it } from 'vitest';
import { connectorOfRef, lineFor, ProgressMapper, toolOf } from './orch-progress';

describe('lineFor: a tool call in plain words', () => {
  it('names the connector and what it reads, never an id', () => {
    expect(toolOf('mcp__claude_ai_Slack__slack_read_channel')).toEqual({ connector: 'slack', tool: 'slack_read_channel' });
    expect(lineFor('mcp__claude_ai_Slack__slack_read_channel', { channel_name: 'eng' })).toEqual({ connector: 'slack', label: 'Reading #eng' });
    expect(lineFor('mcp__claude_ai_Slack__slack_read_channel', { channel_id: 'C0123ABCD' })!.label).toBe('Reading a Slack channel');
    expect(lineFor('mcp__claude_ai_Slack__slack_search_public_and_private', { query: 'from:me payout' })!.label).toBe('Searching Slack for "from:me payout"');
    expect(lineFor('mcp__claude_ai_Linear__list_issues', { assignee: 'me' })).toEqual({ connector: 'linear', label: 'Listing issues you own' });
    expect(lineFor('mcp__claude_ai_Linear__get_issue', { id: 'LAR-88' })!.label).toBe('Opening LAR-88');
    expect(lineFor('mcp__rig__rig_github', { command: 'gh pr view 212 --repo acme/api' })).toEqual({ connector: 'github', label: 'Opening #212' });
    expect(lineFor('mcp__rig__rig_github', { command: 'gh search prs --review-requested=@me' })!.label).toBe('Listing pull requests that wait on you');
    expect(lineFor('mcp__rig__rig_query', { kind: 'situations' })).toEqual({ connector: 'rig', label: 'Looking at what Rig knows: situations' });
    expect(lineFor('mcp__claude_ai_Granola__get_meetings', {})!.label).toBe('Reading Granola');
  });

  it('keeps the run note and unknown tools off the screen', () => {
    expect(lineFor('mcp__rig__rig_run_note', {})).toBeNull();
    expect(lineFor('Read', { file_path: '/x' })).toBeNull();
  });

  it('tells the connector of a ref', () => {
    expect(connectorOfRef('msg:slack:C1:123')).toBe('slack');
    expect(connectorOfRef('item:LAR-91')).toBe('linear');
    expect(connectorOfRef('github:acme/api#212')).toBe('github');
    expect(connectorOfRef('sit_1')).toBeNull();
  });
});

describe('ProgressMapper', () => {
  it('starts a line, improves it as the input streams in, and resolves it when the call ends', () => {
    let now = 0;
    const m = new ProgressMapper(() => now);
    const first = m.push({ sessionUpdate: 'tool_call', toolCallId: 't1', name: 'mcp__claude_ai_Slack__slack_read_channel', status: 'pending', rawInput: {} });
    expect(first).toEqual([{ kind: 'line', line: { id: 't1', connector: 'slack', label: 'Reading a Slack channel', status: 'running', t: 0 } }]);
    now = 40;
    expect(m.push({ sessionUpdate: 'tool_call_update', toolCallId: 't1', rawInput: { channel_name: 'eng' } })).toEqual([
      { kind: 'line', line: { id: 't1', connector: 'slack', label: 'Reading #eng', status: 'running', t: 40 } },
    ]);
    // Nothing new: nothing sent.
    expect(m.push({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' })).toEqual([]);
    now = 900;
    expect(m.push({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' })[0]).toMatchObject({ line: { id: 't1', status: 'done', t: 900 } });
  });

  it('turns each run-note outcome into its own line once the call is done, and a put card into a card', () => {
    const m = new ProgressMapper(() => 5);
    const outcome = { run_id: 'run_1', outcome: { kind: 'handled', ref: 'msg:slack:C1:1', text: 'Payout delay: Sam resolved it Tuesday' } };
    expect(m.push({ sessionUpdate: 'tool_call', toolCallId: 'n1', name: 'mcp__rig__rig_run_note', status: 'pending', rawInput: outcome })).toEqual([]);
    expect(m.push({ sessionUpdate: 'tool_call_update', toolCallId: 'n1', status: 'completed' })).toEqual([
      { kind: 'line', line: { id: 'outcome:n1', connector: 'slack', label: 'Payout delay: Sam resolved it Tuesday', status: 'handled', ref: 'msg:slack:C1:1', t: 5 } },
    ]);
    // The end-of-run note is no line.
    m.push({ sessionUpdate: 'tool_call', toolCallId: 'n2', name: 'mcp__rig__rig_run_note', rawInput: { run_id: 'run_1', summary: 'ok' } });
    expect(m.push({ sessionUpdate: 'tool_call_update', toolCallId: 'n2', status: 'completed' })).toEqual([]);
    m.push({ sessionUpdate: 'tool_call', toolCallId: 'f1', name: 'mcp__rig__rig_feed', rawInput: { op: 'put', ref: 'sit_9' } });
    const put = m.push({ sessionUpdate: 'tool_call_update', toolCallId: 'f1', status: 'completed' });
    expect(put[0]).toEqual({ kind: 'card', ref: 'sit_9', t: 5 });
    expect(put[1]).toMatchObject({ kind: 'line', line: { label: 'Putting a card on your Feed', status: 'done' } });
  });
});
