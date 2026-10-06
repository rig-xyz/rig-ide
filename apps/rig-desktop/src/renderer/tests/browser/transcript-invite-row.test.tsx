import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InviteRow } from '@renderer/features/spaces/components/transcript-items';
import type { RoomMessage, RoomSnapshot } from '@renderer/features/spaces/types';

/**
 * Lane J: the Room's invite card must not claim "Invite sent by email" for
 * a live invite — the relay's Room message and invite list don't carry
 * whether the email went out, and the share popover can say it didn't.
 */

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const message: RoomMessage = {
  id: 'm1',
  seq: 1,
  authorId: 'u-dylan',
  createdAt: new Date().toISOString(),
  time: '14:02',
  body: 'invited sam@play.local',
  meta: { kind: 'invite', inviteId: 'inv1' },
} as RoomMessage;

function snapshotWith(invite: RoomSnapshot['invitesById'][string], members: RoomSnapshot['members'] = []): RoomSnapshot {
  return { members, invitesById: { inv1: invite } } as unknown as RoomSnapshot;
}

describe('InviteRow status (live invite)', () => {
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

  async function render(snapshot: RoomSnapshot) {
    await act(async () => root.render(<InviteRow message={message} snapshot={snapshot} />));
  }

  it('names who was invited without claiming an email went out', async () => {
    await render(
      snapshotWith({ id: 'inv1', by: 'u-dylan', who: 'sam@play.local', email: 'sam@play.local', role: 'editor', status: 'sent' })
    );
    expect(host.textContent).toContain('Invited sam@play.local');
    expect(host.textContent).not.toContain('sent by email');
  });

  it('names a person invited by name, and never shows an id for an inviter who left', async () => {
    await render(
      snapshotWith({
        id: 'inv1',
        by: 'u-dylan',
        who: '',
        email: null,
        role: 'editor',
        status: 'sent',
        target: { userId: 'usr_jer', name: 'Jérémie Rappaz', avatarUrl: null },
      })
    );
    expect(host.textContent).toContain('Invited Jérémie Rappaz');
    expect(host.textContent).not.toContain('Anyone with the link');
    expect(host.textContent).not.toContain('u-dylan');
    expect(host.textContent).toContain('Someone invited someone');
  });

  it('says "Invite link created" for an open link', async () => {
    await render(snapshotWith({ id: 'inv1', by: 'u-dylan', who: '', email: null, role: 'editor', status: 'sent' }));
    expect(host.textContent).toContain('Invite link created');
  });

  it('pictures an open link with a link glyph, not "AL" initials', async () => {
    await render(snapshotWith({ id: 'inv1', by: 'u-dylan', who: '', email: null, role: 'editor', status: 'sent' }));
    const card = host.querySelector('[data-testid="invite-link-avatar"]');
    expect(card?.querySelector('svg')).toBeTruthy();
    expect(host.textContent).toContain('Anyone with the link');
    expect(host.textContent).not.toContain('AL');
  });

  it('keeps the initials avatar for an emailed invite', async () => {
    await render(
      snapshotWith({ id: 'inv1', by: 'u-dylan', who: 'sam@play.local', email: 'sam@play.local', role: 'editor', status: 'sent' })
    );
    expect(host.querySelector('[data-testid="invite-link-avatar"]')).toBeNull();
  });

  it('says "Joined" once the invitee is a member', async () => {
    await render(
      snapshotWith({ id: 'inv1', by: 'u-dylan', who: 'sam@play.local', email: 'sam@play.local', role: 'editor', status: 'joined' })
    );
    expect(host.textContent).toContain('Joined');
  });
});
