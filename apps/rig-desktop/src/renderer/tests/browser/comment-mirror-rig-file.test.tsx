import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetViewRequestsForTests, useViewRequest, type ViewRequest } from '@renderer/features/artifact/view-request';
import { CommentMirrorLine } from '@renderer/features/spaces/components/transcript-items';
import { buildRoomFeed } from '@renderer/features/spaces/fixtures/room-feed';
import { FixtureRoomSource } from '@renderer/features/spaces/room-source';
import type { RoomMessage } from '@renderer/features/spaces/types';

vi.mock('@renderer/lib/ipc', () => ({
  rpc: { app: { openExternal: async () => {} } },
  events: { on: () => () => {} },
}));

/**
 * A pin on a space's html file is stored under its rig-file link. Its row in
 * the Room names the file by its path, like a comment on a file, and opens
 * the file at the pin's thread, not the raw link.
 */
const LINK = 'rig-file://bnd_jak0s9/index.html';

function snapshot() {
  const source = new FixtureRoomSource(buildRoomFeed());
  source.replayAll();
  return source.getSnapshot();
}

const message = (authorId: string): RoomMessage => ({
  id: 'msg_501f',
  seq: 1,
  authorId,
  createdAt: '2026-10-09T21:22:58.529Z',
  time: '17:22',
  body: 'test',
  meta: { kind: 'comment_mirror', commentId: 'msg_501f', path: LINK, quote: 'warm-island', pin: 1 },
});

describe('a comment on a space html file, in the Room', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    resetViewRequestsForTests();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('names the file by its path and opens it at the thread', async () => {
    const snap = snapshot();
    const onOpenFile = vi.fn();
    await act(async () => {
      root.render(<CommentMirrorLine message={message(snap.members[0]!.id)} snapshot={snap} onOpenFile={onOpenFile} />);
    });
    const chip = host.querySelector<HTMLButtonElement>('[data-testid="comment-file-chip"]')!;
    expect(chip.textContent).toBe('index.html');
    expect(host.textContent).not.toContain('rig-file://');

    await act(async () => chip.click());
    // The Room's link handler opens a space's rig-file link as its file, in Browser mode.
    expect(onOpenFile).toHaveBeenCalledWith(LINK);
    // The page, once it shows, is asked for the pin's thread.
    const seen: ViewRequest[] = [];
    function Page() {
      useViewRequest(LINK, (request) => seen.push(request));
      return null;
    }
    await act(async () => root.render(<Page />));
    expect(seen).toEqual([{ thread: 'msg_501f' }]);
  });
});
