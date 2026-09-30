import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from '@renderer/features/spaces/components/composer';
import {
  ReactionsContext,
  type ReactionsApi,
} from '@renderer/features/spaces/components/reactions';
import { MessageRow } from '@renderer/features/spaces/components/transcript-items';
import { loadEmojiIndex } from '@renderer/features/spaces/emoji-data';
import type { RoomMember, RoomMessage, RoomSnapshot } from '@renderer/features/spaces/types';
import type { MessageReaction } from '@shared/spaces/reactions';
import '@renderer/tokens.css';

// Message rows render attachments, which import the IPC bridge; nothing here uses it.
vi.mock('@renderer/lib/ipc', () => ({
  rpc: { app: { openExternal: async () => {} }, rig: {} },
  events: { on: () => () => {} },
}));

/**
 * Spaces reactions: chips under a message (yours highlighted, click to
 * toggle, hover for who), the hover bar's quick five and picker, and the
 * composer's emoji picker and `:` autocomplete. Structure only: Tailwind
 * isn't loaded here, so nothing asserts computed style.
 */

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

const MEMBERS: RoomMember[] = [
  { id: 'me', name: 'Dylan', email: 'd@x.co', role: 'owner', initial: 'D', status: 'here' },
  { id: 'maya', name: 'Maya', email: 'm@x.co', role: 'editor', initial: 'M', status: 'here' },
  ...Array.from({ length: 12 }, (_, i) => ({
    id: `p${i}`,
    name: `Person ${i}`,
    email: `p${i}@x.co`,
    role: 'viewer',
    initial: 'P',
    status: 'here' as const,
  })),
];

function snapshotWith(messages: RoomMessage[]): RoomSnapshot {
  return {
    name: 'growth',
    ready: true,
    members: MEMBERS,
    agents: [],
    connectors: [],
    skills: [],
    messages,
    invitesById: {},
    sessionMetaByRun: {},
    sessionEventsByRun: {},
    typingUserIds: [],
  };
}

function message(reactions: MessageReaction[] | undefined, authorId = 'maya'): RoomMessage {
  return {
    id: 'msg-1',
    seq: 7,
    authorId,
    createdAt: '2026-09-29T10:00:00Z',
    time: '10:00',
    body: 'Ship on Friday?',
    meta: { kind: 'text' },
    ...(reactions ? { reactions } : {}),
  };
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

async function setTextareaValue(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('reaction chips', () => {
  let host: HTMLDivElement;
  let root: Root;
  const react = vi.fn<ReactionsApi['react']>();

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    react.mockReset();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    for (const el of document.querySelectorAll(
      '[data-testid="reactors-card"],[data-testid="reactors-all"],[data-testid="emoji-picker"]'
    )) {
      el.closest('[role]')?.remove();
    }
  });

  async function render(msg: RoomMessage, api: ReactionsApi | null = { react }) {
    await act(async () => {
      root.render(
        <ReactionsContext.Provider value={api}>
          <MessageRow message={msg} snapshot={snapshotWith([msg])} ownId="me" />
        </ReactionsContext.Provider>
      );
    });
  }

  it('shows emoji and count under the message, yours marked, and a click toggles yours', async () => {
    await render(
      message([
        {
          emoji: '👍',
          count: 2,
          reactors: [
            { userId: 'maya', agent: null },
            { userId: 'me', agent: null },
          ],
        },
        { emoji: '🎉', count: 1, reactors: [{ userId: 'maya', agent: 'claude' }] },
      ])
    );
    const chips = [...host.querySelectorAll<HTMLElement>('[data-testid="reaction-chip"]')];
    expect(chips.map((c) => c.textContent)).toEqual(['👍2', '🎉1']);
    expect(chips.map((c) => c.dataset.mine)).toEqual(['true', 'false']);
    expect(chips[0]!.getAttribute('aria-pressed')).toBe('true');

    await act(async () => click(chips[0]!));
    expect(react).toHaveBeenLastCalledWith('msg-1', '👍', false);
    await act(async () => click(chips[1]!));
    expect(react).toHaveBeenLastCalledWith('msg-1', '🎉', true);
  });

  it('shows nothing under a message without reactions', async () => {
    await render(message(undefined));
    expect(host.querySelector('[data-testid="reaction-chips"]')).toBeNull();
  });

  it('hovering a chip lists who: names with avatars, agents as "Maya\'s Claude", you as "You"', async () => {
    await render(
      message([
        {
          emoji: '👀',
          count: 3,
          reactors: [
            { userId: 'maya', agent: null },
            { userId: 'maya', agent: 'claude' },
            { userId: 'me', agent: 'codex' },
          ],
        },
      ])
    );
    const chip = host.querySelector<HTMLElement>('[data-testid="reaction-chip"]')!;
    expect(chip.getAttribute('aria-label')).toBe("👀 3: Maya, Maya's Claude, Your Codex");
    await act(async () => chip.focus());
    const card = document.querySelector<HTMLElement>('[data-testid="reactors-card"]')!;
    expect(card).not.toBeNull();
    const rows = [...card.querySelectorAll('[data-testid="reactor"]')];
    // Each with its avatar (a person's circle, or the agent's logo with its owner's badge), then the name.
    for (const r of rows) expect(r.children).toHaveLength(2);
    expect(rows.map((r) => r.lastElementChild!.textContent)).toEqual([
      'Maya',
      "Maya's Claude",
      'Your Codex',
    ]);
    expect(card.querySelector('[data-testid="reactors-show-all"]')).toBeNull();
  });

  it('more than ten: the first ten, then "and N others", which opens the whole list', async () => {
    const reactors = MEMBERS.slice(1).map((m) => ({ userId: m.id, agent: null }));
    expect(reactors).toHaveLength(13);
    await render(message([{ emoji: '🎉', count: 13, reactors }]));
    const chip = host.querySelector<HTMLElement>('[data-testid="reaction-chip"]')!;
    await act(async () => chip.focus());
    const card = document.querySelector<HTMLElement>('[data-testid="reactors-card"]')!;
    expect(card.querySelectorAll('[data-testid="reactor"]')).toHaveLength(10);
    const more = card.querySelector<HTMLElement>('[data-testid="reactors-show-all"]')!;
    expect(more.textContent).toBe('and 3 others');
    await act(async () => click(more));
    expect(document.querySelector('[data-testid="reactors-card"]')).toBeNull();
    const all = document.querySelector<HTMLElement>('[data-testid="reactors-all"]')!;
    expect(all.querySelectorAll('[data-testid="reactor"]')).toHaveLength(13);
    expect(all.textContent).toContain('Person 11');
  });

  it("the hover bar's quick five toggle yours, and + opens the picker", async () => {
    await render(message([{ emoji: '👍', count: 1, reactors: [{ userId: 'me', agent: null }] }]));
    const quick = [...host.querySelectorAll<HTMLElement>('[data-testid="quick-reaction"]')];
    expect(quick.map((b) => b.textContent)).toEqual(['👍', '❤️', '😂', '🎉', '👀']);
    await act(async () => click(quick[0]!));
    expect(react).toHaveBeenLastCalledWith('msg-1', '👍', false);
    await act(async () => click(quick[4]!));
    expect(react).toHaveBeenLastCalledWith('msg-1', '👀', true);

    await act(async () => click(host.querySelector('[data-testid="quick-reaction-more"]')!));
    await loadEmojiIndex();
    await flush();
    const picker = document.querySelector<HTMLElement>('[data-testid="emoji-picker"]')!;
    expect(picker).not.toBeNull();
    // The bar stays up while the picker is open.
    expect(host.querySelector<HTMLElement>('[data-testid="row-actions"]')!.className).toContain(
      'opacity-100'
    );
    await typeInto(
      picker.querySelector<HTMLInputElement>('[data-testid="emoji-search"]')!,
      'rocket'
    );
    const first = picker.querySelector<HTMLElement>(
      '[data-testid="emoji-results"] [data-testid="emoji-option"]'
    )!;
    expect(first.dataset.emoji).toBe('🚀');
    await act(async () => click(first));
    expect(react).toHaveBeenLastCalledWith('msg-1', '🚀', true);
    expect(document.querySelector('[data-testid="emoji-picker"]')).toBeNull();
  });

  it('the picker offers your frequently used emoji and every category', async () => {
    localStorage.removeItem('rig-emoji-frequent');
    await render(message(undefined));
    await act(async () => click(host.querySelector('[data-testid="quick-reaction-more"]')!));
    await loadEmojiIndex();
    await flush();
    const picker = document.querySelector<HTMLElement>('[data-testid="emoji-picker"]')!;
    const frequent = [
      ...picker.querySelectorAll<HTMLElement>(
        '[data-testid="emoji-frequent"] [data-testid="emoji-option"]'
      ),
    ];
    expect(frequent.map((b) => b.dataset.emoji)).toEqual(['👍', '❤️', '😂', '🎉', '👀']);
    expect(
      [...picker.querySelectorAll('[role="tab"]')].map((t) => t.getAttribute('aria-label'))
    ).toEqual([
      'Smileys & emotion',
      'People & body',
      'Animals & nature',
      'Food & drink',
      'Travel & places',
      'Activities',
      'Objects',
      'Symbols',
      'Flags',
    ]);
    // A pick counts toward "Frequently used".
    await act(async () =>
      click(picker.querySelector('[data-group="food"] [data-testid="emoji-option"]')!)
    );
    expect(
      Object.keys(JSON.parse(localStorage.getItem('rig-emoji-frequent') ?? '{}'))
    ).toHaveLength(1);
    localStorage.removeItem('rig-emoji-frequent');
  });

  it("without a live Room (the scripted demo) chips show but can't be changed, and there's no quick bar", async () => {
    await render(
      message([{ emoji: '👍', count: 1, reactors: [{ userId: 'maya', agent: null }] }]),
      null
    );
    expect(host.querySelector('[data-testid="reaction-chip"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="quick-reaction"]')).toBeNull();
    await act(async () => click(host.querySelector('[data-testid="reaction-chip"]')!));
    expect(react).not.toHaveBeenCalled();
  });
});

describe('composer emoji', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root.render(
        <Composer spaceName="growth" members={MEMBERS} agents={[]} skills={[]} onSend={() => {}} />
      );
    });
    await loadEmojiIndex();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  const menu = () => host.querySelector<HTMLElement>('[data-testid="skills-palette"]');

  it('":" and two letters opens matching emoji; Enter puts in the emoji itself', async () => {
    const textarea = host.querySelector('textarea')!;
    await setTextareaValue(textarea, 'we shipped :t');
    await flush();
    expect(menu()).toBeNull();
    await setTextareaValue(textarea, 'we shipped :tad');
    await flush();
    expect(menu()?.textContent).toContain('Emoji');
    const options = [...menu()!.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options[0]!.textContent).toContain('🎉');
    expect(options[0]!.textContent).toContain(':tada:');
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(textarea.value).toBe('we shipped 🎉 ');
    expect(menu()).toBeNull();
  });

  it('Tab picks too, and arrows move through the matches', async () => {
    const textarea = host.querySelector('textarea')!;
    await setTextareaValue(textarea, ':thumbs');
    await flush();
    const options = [...menu()!.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options.length).toBeGreaterThan(1);
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    const second = [...menu()!.querySelectorAll<HTMLElement>('[role="option"]')][1]!;
    expect(second.getAttribute('aria-selected')).toBe('true');
    const emoji = second.querySelector('span')!.textContent!;
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    expect(textarea.value).toBe(`${emoji} `);
  });

  it('never opens inside a time or a link', async () => {
    const textarea = host.querySelector('textarea')!;
    for (const text of [
      'meet at 10:30',
      'see https://example.com',
      'http://localhost:ab',
      'Note:ok',
      'ratio 3:ab',
    ]) {
      await setTextareaValue(textarea, text);
      await flush();
      expect(menu(), text).toBeNull();
    }
  });

  it('the smiley button opens the picker, which inserts at the cursor', async () => {
    const textarea = host.querySelector('textarea')!;
    await setTextareaValue(textarea, 'good job team');
    textarea.focus();
    textarea.setSelectionRange(9, 9); // after "good job "
    await act(async () => click(host.querySelector('[data-testid="composer-emoji"]')!));
    await flush();
    const picker = document.querySelector<HTMLElement>('[data-testid="emoji-picker"]')!;
    expect(picker).not.toBeNull();
    await typeInto(picker.querySelector<HTMLInputElement>('[data-testid="emoji-search"]')!, 'tada');
    await act(async () => {
      picker
        .querySelector<HTMLInputElement>('[data-testid="emoji-search"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await flush();
    expect(textarea.value).toBe('good job 🎉team');
    expect(document.querySelector('[data-testid="emoji-picker"]')).toBeNull();
    localStorage.removeItem('rig-emoji-frequent');
  });
});
