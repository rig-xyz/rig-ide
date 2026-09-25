import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AgentRows } from '@renderer/features/spaces/components/agent-rows';
import { buildRoomFeed } from '@renderer/features/spaces/fixtures/room-feed';
import { FixtureRoomSource } from '@renderer/features/spaces/room-source';
import type { SessionRunMeta } from '@renderer/features/spaces/types';

/**
 * Polish round 2, lane F (Dylan): the Agents section's collapsed summary
 * shows each agent KIND once — one Claude logo, one Codex logo — even when
 * several different people each run that kind. Per-person instances stay
 * exclusive to the expanded list (covered by `spaces-room.test.tsx`'s own
 * Agents coverage); this file only pins the collapsed dedup.
 */

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

function replayedSnapshot() {
  const source = new FixtureRoomSource(buildRoomFeed());
  source.replayAll();
  return source.getSnapshot();
}

describe('AgentRows — collapsed summary', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('shows one avatar per agent kind, not one per (owner, kind) instance', async () => {
    // Base fixture: bob owns claude+codex (his own agents, always both,
    // see relay-room-source.ts's `emptySnapshot`) — but replayed via the
    // fixture reducer, `mine` here comes from `session_started` events, and
    // alice only ever runs codex in the base script. Inject a second
    // claude run for alice so TWO different owners both have a claude
    // instance — the collapsed stack must still show exactly one Claude
    // logo (and exactly one Codex logo), never two of either.
    const aliceClaude: SessionRunMeta = {
      id: 'run-alice-claude',
      agent: 'claude',
      owner: 'alice',
      model: 'unknown',
      title: '',
      status: 'done',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    };
    const snapshot = replayedSnapshot();
    await act(async () => {
      root.render(
        <AgentRows
          snapshot={{
            ...snapshot,
            sessionMetaByRun: { ...snapshot.sessionMetaByRun, 'run-alice-claude': aliceClaude },
            sessionEventsByRun: { ...snapshot.sessionEventsByRun, 'run-alice-claude': [] },
          }}
          selfUserId="bob"
          bindingId="space-agents-kind-dedup"
        />
      );
    });

    // Collapsed by default.
    expect(host.querySelector('[data-testid="agents-expanded"]')).toBeNull();

    const kindAvatars = [...host.querySelectorAll<HTMLElement>('[data-testid="agent-kind-avatar"]')];
    const kinds = kindAvatars.map((el) => el.dataset.kind).sort();
    expect(kinds).toEqual(['claude', 'codex']);

    // Expanding reveals the per-person instances — bob's own claude row,
    // plus (at least) alice's and whoever else's claude/codex rows.
    const summary = host.querySelector<HTMLButtonElement>('[data-testid="agents-summary-row"]')!;
    await act(async () => summary.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(host.querySelector('[data-testid="agents-avatar-stack"]')).toBeNull();
    expect(host.querySelector('[data-testid="space-agent-row"]')).not.toBeNull();
    const theirsRows = [...host.querySelectorAll<HTMLElement>('[data-testid="space-agent-row-theirs"]')];
    expect(theirsRows.some((row) => row.title === "Only Alice can change Alice's Claude")).toBe(true);
  });
});
