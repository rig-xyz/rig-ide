import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer, type ComposerSendContext } from '@renderer/features/spaces/components/composer';
import type { MentionPerson } from '@renderer/features/spaces/mentions';
import type { RoomMember } from '@renderer/features/spaces/types';
import '@renderer/tokens.css';

vi.mock('@renderer/lib/ipc', () => ({
  rpc: { app: { openExternal: async () => {} }, rig: {} },
  events: { on: () => () => {} },
}));

/**
 * Tagging people by full name (rig/docs/people-management-scope.md, board 26
 * panel 2): accents and spaces in the `@` query, the In this space / Invited /
 * Your people groups, ids sent with the message, and the offer to invite
 * someone tagged from outside the space.
 */

function member(id: string, name: string): RoomMember {
  return { id, name, email: '', role: 'editor', initial: name[0]!, status: 'here' };
}

const MEMBERS = [
  member('usr_me', 'Dylan Bourgeois'),
  member('usr_hugo', 'Hugo Renaudin'),
  member('usr_alex_a', 'Alex Martin'),
];
const PEOPLE: MentionPerson[] = [
  { id: 'usr_ines', name: 'Inès Invited', avatarUrl: null, group: 'invited' },
  {
    id: 'usr_jer',
    name: 'Jérémie Rappaz',
    avatarUrl: null,
    group: 'outside',
    detail: '2 spaces with you',
  },
];

async function type(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function key(textarea: HTMLTextAreaElement, name: string): Promise<void> {
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
  });
}

async function click(el: Element | null | undefined): Promise<void> {
  expect(el).toBeTruthy();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('Composer: tag anyone by their full name', () => {
  let host: HTMLDivElement;
  let root: Root;
  let sent: Array<[string, ComposerSendContext]>;
  let invited: string[];
  let inviteWorks: boolean;

  async function mount(): Promise<HTMLTextAreaElement> {
    await act(async () => {
      root.render(
        <Composer
          spaceName="#launch-plan"
          members={MEMBERS}
          agents={[]}
          skills={[]}
          people={PEOPLE}
          onSend={(text, context) => sent.push([text, context])}
          onInvitePerson={async (person) => {
            invited.push(person.id);
            return inviteWorks;
          }}
        />
      );
    });
    return host.querySelector<HTMLTextAreaElement>('textarea')!;
  }

  const options = () => [
    ...host.querySelectorAll<HTMLElement>('[data-testid="mention-palette"] [role="option"]'),
  ];
  const palette = () => host.querySelector('[data-testid="mention-palette"]');
  const notice = () => host.querySelector('[data-testid="composer-outsider-notice"]');

  beforeEach(() => {
    sent = [];
    invited = [];
    inviteWorks = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('groups who it offers: in this space (invited people tagged), then your people', async () => {
    const textarea = await mount();
    await type(textarea, '@');
    expect(palette()?.textContent).toContain('In this space');
    expect(palette()?.textContent).toContain('Your people, not in this space');
    const labels = options().map((o) => o.textContent);
    expect(labels[0]).toContain('@Dylan Bourgeois');
    expect(labels.find((l) => l?.includes('Inès Invited'))).toContain('Invited');
    expect(labels.at(-1)).toContain('@Jérémie Rappaz');
  });

  it('matches accents, any word and across a space, and Enter puts the whole name in', async () => {
    const textarea = await mount();
    await type(textarea, 'hey @jer');
    expect(options().map((o) => o.textContent)).toEqual([
      expect.stringContaining('@Jérémie Rappaz'),
    ]);
    await type(textarea, 'hey @Jérémie Ra');
    expect(options()).toHaveLength(1);
    await type(textarea, 'hey @rena');
    expect(options()[0]?.textContent).toContain('@Hugo Renaudin');
    await key(textarea, 'Enter');
    expect(textarea.value).toBe('hey @Hugo Renaudin ');
    expect(palette()).toBeNull();
  });

  it('sends the ids of the people still tagged in the text', async () => {
    const textarea = await mount();
    await type(textarea, '@hug');
    await key(textarea, 'Tab');
    await type(textarea, `${textarea.value}and @alex`);
    await key(textarea, 'Tab');
    // Hugo's tag deleted before sending: only Alex goes.
    await type(textarea, 'and @Alex Martin can you look');
    await key(textarea, 'Enter');
    expect(sent).toHaveLength(1);
    expect(sent[0]![1].mentions).toEqual([{ id: 'usr_alex_a', name: 'Alex Martin' }]);
  });

  it('offers to invite someone tagged from outside the space, and invites then sends', async () => {
    const textarea = await mount();
    await type(textarea, 'can you check @Jér');
    await key(textarea, 'Tab');
    expect(notice()?.textContent).toContain(
      'Jérémie Rappaz isn’t in #launch-plan and won’t see this. Invite Jérémie Rappaz?'
    );
    await type(textarea, `${textarea.value}the pricing table`);
    await click(host.querySelector('[data-testid="composer-invite-and-send"]'));
    expect(invited).toEqual(['usr_jer']);
    expect(sent).toEqual([
      [
        'can you check @Jérémie Rappaz the pricing table',
        expect.objectContaining({ mentions: [{ id: 'usr_jer', name: 'Jérémie Rappaz' }] }),
      ],
    ]);
    expect(notice()).toBeNull();
  });

  it('Send only sends without inviting', async () => {
    const textarea = await mount();
    await type(textarea, '@jérémie');
    await key(textarea, 'Enter');
    expect(notice()).not.toBeNull();
    await click(host.querySelector('[data-testid="composer-send-only"]'));
    expect(invited).toEqual([]);
    expect(sent.map(([text]) => text)).toEqual(['@Jérémie Rappaz']);
  });

  it('keeps the draft when the invite fails', async () => {
    inviteWorks = false;
    const textarea = await mount();
    await type(textarea, '@jérémie');
    await key(textarea, 'Enter');
    await click(host.querySelector('[data-testid="composer-invite-and-send"]'));
    expect(invited).toEqual(['usr_jer']);
    expect(sent).toEqual([]);
    expect(textarea.value).toBe('@Jérémie Rappaz ');
    expect(notice()).not.toBeNull();
  });

  it('says nothing about someone already in the space', async () => {
    const textarea = await mount();
    await type(textarea, '@hugo');
    await key(textarea, 'Enter');
    expect(notice()).toBeNull();
  });
});
