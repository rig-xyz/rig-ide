import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * People's messages in the Room read as light markdown (code, bold, lists…)
 * with the Room's mentions, links and file tags only in ordinary text; the
 * composer's ⌘B / ⌘I / ⌘E write the markers.
 */

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    app: { openExternal: async () => {} },
    agents: { list: async () => [] },
    rig: { pages: { linkTitle: async () => null } },
  },
  events: { on: () => () => {} },
}));

import { Composer, type ComposerSendContext } from '@renderer/features/spaces/components/composer';
import { MessageRow } from '@renderer/features/spaces/components/transcript-items';
import type { RoomMessage, RoomSnapshot } from '@renderer/features/spaces/types';

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('a person’s message', () => {
  const snapshot = {
    members: [
      { id: 'u_hugo', name: 'Hugo Renaudin' },
      { id: 'u_me', name: 'Me' },
    ],
  } as unknown as RoomSnapshot;
  const message = (body: string): RoomMessage =>
    ({
      id: 'm1',
      authorId: 'u_hugo',
      body,
      createdAt: '2026-10-06T10:00:00.000Z',
      meta: { kind: 'text' },
      reactions: [],
    }) as unknown as RoomMessage;

  async function show(body: string): Promise<HTMLElement> {
    await act(async () =>
      root.render(<MessageRow message={message(body)} snapshot={snapshot} ownId="u_me" />)
    );
    return host.querySelector<HTMLElement>('[data-highlight-target]')!;
  }

  it('shows inline code as code, with no mention inside it', async () => {
    const bubble = await show(
      'si tu fais `npm install -g @openai/codex@latest` sur ta machine, @Me'
    );
    expect(bubble.querySelector('code')?.textContent).toBe('npm install -g @openai/codex@latest');
    expect([...bubble.querySelectorAll('span.text-accent')].map((s) => s.textContent)).toEqual([
      '@Me',
    ]);
    expect(bubble.querySelector('span.bg-accent-subtle')?.textContent).toBe('@Me');
    expect(bubble.textContent).toBe(
      'si tu fais npm install -g @openai/codex@latest sur ta machine, @Me'
    );
  });

  it('keeps line breaks, renders bold, lists and code blocks, and copies the raw text', async () => {
    const body = 'first line\nsecond **line**\n\n- one\n- two\n\n```\n@claude stays code\n```';
    const bubble = await show(body);
    expect(bubble.querySelectorAll('p br')).toHaveLength(1);
    expect(bubble.querySelector('strong')?.textContent).toBe('line');
    expect([...bubble.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['one', 'two']);
    expect(bubble.querySelector('pre code')?.textContent).toBe('@claude stays code\n');
    expect(bubble.querySelector('span.text-accent')).toBeNull();
    // No pre-wrap on the bubble any more: the markup's own newlines between blocks don't show.
    expect(bubble.className).not.toContain('whitespace-pre-wrap');
    const copy = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: copy },
      configurable: true,
    });
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Copy"]')!.click());
    expect(copy).toHaveBeenCalledWith(body);
  });

  it('keeps file tags and link chips in ordinary text', async () => {
    const bubble = await show('_see_ +notes/plan.md and https://userig.xyz/download.');
    expect(bubble.querySelector('em')?.textContent).toBe('see');
    expect(bubble.querySelector<HTMLElement>('[data-testid="file-tag"]')?.dataset.path).toBe(
      'notes/plan.md'
    );
    expect(bubble.querySelector('[data-testid="message-link-chip"]')?.textContent).toBe(
      'userig.xyz/download'
    );
  });
});

describe('composer formatting keys', () => {
  const mac = /Mac/i.test(navigator.platform);

  async function render(): Promise<HTMLTextAreaElement> {
    const sent: Array<[string, ComposerSendContext]> = [];
    await act(async () =>
      root.render(
        <Composer
          spaceName="#growth"
          members={[]}
          agents={[]}
          skills={[]}
          onSend={(text, context) => sent.push([text, context])}
        />
      )
    );
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!;
    textarea.focus();
    return textarea;
  }

  async function type(textarea: HTMLTextAreaElement, value: string): Promise<void> {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(textarea, value);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  async function press(
    textarea: HTMLTextAreaElement,
    key: string,
    mods: KeyboardEventInit = mac ? { metaKey: true } : { ctrlKey: true }
  ) {
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods })
      );
    });
  }

  it('wraps the selection in ** _ ` and selects the words inside', async () => {
    const textarea = await render();
    await type(textarea, 'make this bold');
    textarea.setSelectionRange(5, 9);
    await press(textarea, 'b');
    expect(textarea.value).toBe('make **this** bold');
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([7, 11]);
    await press(textarea, 'i');
    expect(textarea.value).toBe('make **_this_** bold');
    await press(textarea, 'i');
    await press(textarea, 'b');
    expect(textarea.value).toBe('make this bold');
  });

  it('puts a pair of backticks around the cursor', async () => {
    const textarea = await render();
    await type(textarea, 'run ');
    textarea.setSelectionRange(4, 4);
    await press(textarea, 'e');
    expect(textarea.value).toBe('run ``');
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([5, 5]);
  });

  it('leaves other keys alone', async () => {
    const textarea = await render();
    await type(textarea, 'abc');
    textarea.setSelectionRange(0, 3);
    if (mac) await press(textarea, 'e', { ctrlKey: true });
    await press(
      textarea,
      'b',
      mac ? { metaKey: true, shiftKey: true } : { ctrlKey: true, shiftKey: true }
    );
    await press(textarea, 'k');
    expect(textarea.value).toBe('abc');
  });
});
