import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentFileStatus, AttachmentInput, AttachmentVerdict, MessageAttachment } from '@shared/rig/attachments';
import { AttachmentSpaceContext } from '@renderer/features/spaces/components/attachment-cards';
import { Composer, type ComposerSendContext } from '@renderer/features/spaces/components/composer';
import { RoomTranscript } from '@renderer/features/spaces/components/room-transcript';
import { sendFromComposer, withPendingSends } from '@renderer/features/spaces/components/room-view';
import { useComposerAttachments } from '@renderer/features/spaces/use-composer-attachments';
import type { RoomMessage, RoomSnapshot } from '@renderer/features/spaces/types';
import '@renderer/tokens.css';

const api = vi.hoisted(() => ({
  gate: { status: 'ok' as string, message: undefined as string | undefined },
  verdicts: new Map<string, Partial<AttachmentVerdict>>(),
  statuses: [] as AttachmentFileStatus[],
  pick: vi.fn(async () => [] as Array<{ path: string; size: number | null }>),
  usedBytes: 18 * 1024 * 1024 as number | null,
  /** When set, `prepare` for files waits on it (checks still out). */
  hold: null as Promise<void> | null,
  savePastedImage: vi.fn(async () => ({ success: true, data: { path: '/tmp/paste/Screenshot 14.52.png', name: 'Screenshot 14.52.png', size: 3 } })),
  status: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    app: { openExternal: async () => {}, showItemInFolder: async () => {}, clipboardWriteText: async () => {} },
    rig: {
      attachments: {
        pick: api.pick,
        savePastedImage: api.savePastedImage,
        previewSource: async () => null,
        thumbnail: async () => null,
        status: async (args: unknown) => {
          api.status(args);
          return api.statuses;
        },
        usage: async () => ({ usedBytes: api.usedBytes, usageSource: 'relay', limitBytes: 50 * 1024 * 1024 }),
        prepare: async ({ files }: { files: AttachmentInput[] }) => {
          if (files.length && api.hold) await api.hold;
          return {
          space: {
            status: api.gate.status,
            message: api.gate.message,
            limitBytes: 50 * 1024 * 1024,
            addingBytes: files.reduce((sum, f) => sum + ((api.verdicts.get(f.source)?.size as number | undefined) ?? 1024 * 1024), 0),
          },
          files: files.map((f) => {
            const name = f.name ?? f.source.split('/').pop()!;
            const over = api.verdicts.get(f.source) ?? {};
            const secret = over.problems?.some((p) => p.kind === 'secret');
            return {
              source: f.source,
              name,
              storedName: name,
              size: 1024 * 1024,
              mime: 'application/pdf',
              category: 'pdf',
              disposition: 'copy',
              state: 'ok',
              problems: [],
              ...over,
              ...(secret && f.shareAnyway ? { state: 'warn' } : {}),
            } satisfies AttachmentVerdict;
          }),
          };
        },
      },
    },
  },
  events: { on: () => () => {} },
}));

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (window as unknown as { electronAPI: { getPathForFile: (f: File) => string } }).electronAPI = { getPathForFile: () => '' };
});

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 200)));

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function ComposerWithFiles({ onSend, live = true }: { onSend: (text: string, ctx: ComposerSendContext) => void; live?: boolean }) {
  const attachments = useComposerAttachments('bnd_1', live);
  return <Composer spaceName="#growth" members={[]} agents={[]} skills={[]} onSend={onSend} attachments={attachments} />;
}

describe('Composer attachments', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    api.gate = { status: 'ok', message: undefined };
    api.verdicts.clear();
    api.pick.mockClear();
    api.usedBytes = 18 * 1024 * 1024;
    api.hold = null;
    api.savePastedImage.mockClear();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('the paperclip opens the picker; chips show name and size at once, with no footer and no "checking"', async () => {
    api.pick.mockResolvedValueOnce([
      { path: '/Users/me/Q3 board deck.pdf', size: 4404019 },
      { path: '/Users/me/whiteboard.jpg', size: 2048 },
    ]);
    let release!: () => void;
    api.hold = new Promise<void>((resolve) => (release = resolve));
    const onSend = vi.fn();
    await act(async () => root.render(<ComposerWithFiles onSend={onSend} />));
    await settle();
    await act(async () => click(host.querySelector('[data-testid="composer-attach"]')!));
    await settle();
    // Main hasn't answered yet: name and size already, no state label.
    const chips = host.querySelectorAll('[data-testid="attachment-chip"]');
    expect(chips).toHaveLength(2);
    expect(chips[0]!.textContent).toContain('Q3 board deck.pdf');
    expect(chips[0]!.textContent).toContain('4.2 MB');
    expect(chips[1]!.textContent).toContain('2 KB');
    expect(host.textContent).not.toContain('Checking');
    expect(host.querySelector('[data-testid="attachment-footer"]')).toBeNull();
    expect(host.querySelector('[data-testid="attachment-hold-reason"]')).toBeNull();

    // Send while the checks are out: it waits for them, then goes.
    const send = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.startsWith('Send'))!;
    expect(send.disabled).toBe(false);
    await act(async () => click(send));
    expect(onSend).not.toHaveBeenCalled();
    expect(send.getAttribute('aria-busy')).toBe('true');
    await act(async () => release());
    await settle();
    expect(onSend).toHaveBeenCalledOnce();
    const [text, ctx] = onSend.mock.calls[0]! as [string, ComposerSendContext];
    expect(text).toBe('');
    expect(ctx.files?.map((f) => f.source)).toEqual(['/Users/me/Q3 board deck.pdf', '/Users/me/whiteboard.jpg']);
    expect(host.querySelectorAll('[data-testid="attachment-chip"]')).toHaveLength(0);
  });

  it("holds Send with one reason line when the files would put the space over its limit", async () => {
    api.usedBytes = 49.5 * 1024 * 1024;
    api.pick.mockResolvedValueOnce([{ path: '/Users/me/deck.pdf', size: 1024 * 1024 }]);
    await act(async () => root.render(<ComposerWithFiles onSend={() => {}} />));
    await settle();
    await act(async () => click(host.querySelector('[data-testid="composer-attach"]')!));
    await settle();
    expect(host.querySelector('[data-testid="attachment-hold-reason"]')!.textContent).toBe('This would put the space over its 50 MB (at 50 MB now).');
    const send = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.startsWith('Send'))!;
    expect(send.disabled).toBe(true);
  });

  it('a red chip holds Send until it is removed', async () => {
    api.pick.mockResolvedValueOnce([{ path: '/Users/me/demo.mp4', size: 31 * 1024 * 1024 }]);
    api.verdicts.set('/Users/me/demo.mp4', {
      size: 31 * 1024 * 1024,
      state: 'blocked',
      problems: [{ kind: 'tooLarge', message: 'Attachments can be up to 25 MB each. Trim it, or share a link.' }],
    });
    await act(async () => root.render(<ComposerWithFiles onSend={() => {}} />));
    await settle();
    await act(async () => click(host.querySelector('[data-testid="composer-attach"]')!));
    await settle();
    const chip = host.querySelector<HTMLElement>('[data-testid="attachment-chip"]')!;
    expect(chip.dataset.state).toBe('blocked');
    expect(chip.textContent).toContain('over 25 MB');
    const send = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.startsWith('Send'))!;
    expect(send.disabled).toBe(true);
    await act(async () => click(chip.querySelector('button[aria-label^="Remove"]')!));
    expect(host.querySelector('[data-testid="attachment-chip"]')).toBeNull();
  });

  it('a secret needs the typed "share" before it can go', async () => {
    api.pick.mockResolvedValueOnce([{ path: '/Users/me/deploy.pem', size: 100 }]);
    api.verdicts.set('/Users/me/deploy.pem', {
      state: 'blocked',
      problems: [{ kind: 'secret', message: 'This looks like a secret. Everyone in the space (and their agents) would get it.' }],
    });
    await act(async () => root.render(<ComposerWithFiles onSend={() => {}} />));
    await settle();
    await act(async () => click(host.querySelector('[data-testid="composer-attach"]')!));
    await settle();
    const share = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Share anyway…')!;
    await act(async () => click(share));
    const confirm = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Share anyway')!;
    expect(confirm.disabled).toBe(true);
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Type share to confirm"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'share');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(confirm.disabled).toBe(false);
    await act(async () => click(confirm));
    await settle();
    expect(host.querySelector<HTMLElement>('[data-testid="attachment-chip"]')!.dataset.state).toBe('warn');
  });

  it('pasting an image with no text makes a chip from a temp file', async () => {
    await act(async () => root.render(<ComposerWithFiles onSend={() => {}} />));
    await settle();
    const textarea = host.querySelector('textarea')!;
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' }));
    await act(async () => {
      textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await settle();
    expect(api.savePastedImage).toHaveBeenCalled();
    expect(host.querySelector('[data-testid="attachment-chip"]')!.textContent).toContain('Screenshot 14.52.png');
  });

  it("viewers get a paperclip that says why it's off", async () => {
    api.gate = { status: 'viewer', message: 'Viewers can’t add files. Ask an owner or editor.' };
    await act(async () => root.render(<ComposerWithFiles onSend={() => {}} />));
    await settle();
    const clip = host.querySelector<HTMLButtonElement>('[data-testid="composer-attach"]')!;
    expect(clip.getAttribute('aria-disabled')).toBe('true');
    expect(clip.title).toBe('Viewers can’t add files. Ask an owner or editor.');
    await act(async () => click(clip));
    expect(api.pick).not.toHaveBeenCalled();
  });
});

describe('Message cards', () => {
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

  const deck: MessageAttachment = { name: 'Q3 board deck.pdf', size: 4.2 * 1024 * 1024, mime: 'application/pdf', kind: 'copied', path: 'attachments/Q3 board deck.pdf', hash: 'sha256:d', pages: 18 };
  const db: MessageAttachment = { name: 'app.sqlite', size: 10, mime: 'application/vnd.sqlite3', kind: 'local-only' };

  function snapshotWith(messages: RoomMessage[]): RoomSnapshot {
    return {
      name: '#growth',
      ready: true,
      members: [
        { id: 'dylan', name: 'Dylan', email: 'd@x.com', role: 'owner', initial: 'D', status: 'here' },
        { id: 'sam', name: 'Sam', email: 's@x.com', role: 'editor', initial: 'S', status: 'here' },
      ],
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

  const message = (over: Partial<RoomMessage>): RoomMessage => ({
    id: 'm1',
    seq: 1,
    authorId: 'dylan',
    createdAt: new Date().toISOString(),
    time: '14:02',
    body: 'Shared 2 files',
    meta: { kind: 'text', attachments: [deck, db], autoBody: true },
    ...over,
  });

  async function render(snapshot: RoomSnapshot, ownId: string, onOpenFile = vi.fn(), thumbnail: (path: string) => Promise<string | null> = async () => null) {
    await act(async () =>
      root.render(
        <AttachmentSpaceContext.Provider
          value={{
            bindingId: 'bnd_1',
            spaceRoot: '/Users/me/Rig/growth',
            selfUserId: ownId,
            onOpenFile,
            status: async (files, withRelay) => {
              api.status({ bindingId: 'bnd_1', files, withRelay });
              return api.statuses;
            },
            thumbnail,
            reveal: () => {},
            copyText: () => {},
          }}
        >
          <RoomTranscript snapshot={snapshot} ownId={ownId} />
        </AttachmentSpaceContext.Provider>
      )
    );
    await settle();
    return onOpenFile;
  }

  it('your files say syncing until the sync daemon has them; a click opens one beside the chat', async () => {
    api.statuses = [{ path: 'attachments/Q3 board deck.pdf', exists: true, synced: false, onRelay: null }];
    const open = await render(snapshotWith([message({})]), 'dylan');
    const cards = host.querySelectorAll<HTMLElement>('[data-testid="attachment-card"]');
    expect(cards).toHaveLength(2);
    expect(cards[0]!.textContent).toContain('4.2 MB · 18 pages');
    const status = cards[0]!.querySelector<HTMLElement>('[data-testid="attachment-status"]')!;
    expect(status.textContent).toBe('syncing');
    expect(status.title).toBe('Syncing…');
    expect(cards[1]!.textContent).toContain('only on your computer');
    // Files only: the "Shared 2 files" text for older apps isn't shown twice.
    expect(host.querySelector('[data-testid="message-row"]')!.textContent).not.toContain('Shared 2 files');
    await act(async () => click(cards[0]!));
    expect(open).toHaveBeenCalledWith('attachments/Q3 board deck.pdf');
    // Asked about space paths only, never the local-only file.
    expect(api.status).toHaveBeenLastCalledWith({ bindingId: 'bnd_1', files: [{ path: 'attachments/Q3 board deck.pdf', hash: 'sha256:d' }], withRelay: false });
  });

  it("a PDF keeps its card (name, size, pages) with its first page in place of the badge", async () => {
    api.statuses = [{ path: 'attachments/Q3 board deck.pdf', exists: true, synced: true, onRelay: null }];
    const page = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"/>')}`;
    const thumbnail = vi.fn(async (path: string) => (path.endsWith('.pdf') ? page : null));
    await render(snapshotWith([message({ meta: { kind: 'text', attachments: [deck] }, body: 'deck' })]), 'dylan', vi.fn(), thumbnail);
    await vi.waitFor(() => expect(host.querySelector('[data-testid="attachment-page-thumb"]')).not.toBeNull());
    expect(thumbnail).toHaveBeenCalledWith('attachments/Q3 board deck.pdf');
    const card = host.querySelector<HTMLElement>('[data-testid="attachment-card"]')!;
    expect(card.dataset.kind).toBe('copied'); // the card, not a bare image
    expect(card.querySelector<HTMLImageElement>('[data-testid="attachment-page-thumb"]')!.src).toBe(page);
    expect(card.textContent).toContain('Q3 board deck.pdf');
    expect(card.textContent).toContain('4.2 MB · 18 pages');
  });

  it("others see arriving until the file is here, and whose computer a local-only file is on", async () => {
    api.statuses = [{ path: 'attachments/Q3 board deck.pdf', exists: false, synced: null, onRelay: true }];
    await render(snapshotWith([message({})]), 'sam');
    const cards = host.querySelectorAll<HTMLElement>('[data-testid="attachment-card"]');
    const status = cards[0]!.querySelector<HTMLElement>('[data-testid="attachment-status"]')!;
    expect(status.textContent).toBe('arriving');
    expect(status.title).toBe('Arriving from Dylan…');
    expect(cards[1]!.textContent).toContain('only on Dylan’s computer');
  });

  it('a message sent over the quota says so on your card', async () => {
    api.statuses = [{ path: 'attachments/Q3 board deck.pdf', exists: true, synced: false, onRelay: null, notSynced: 'overQuota' }];
    await render(snapshotWith([message({ meta: { kind: 'text', attachments: [deck] } , body: 'here it is' })]), 'dylan');
    const status = host.querySelector<HTMLElement>('[data-testid="attachment-status"]')!;
    expect(status.textContent).toBe('not synced · space full');
    expect(status.title).toBe('Not synced: over the space’s 50 MB');
    expect(host.textContent).toContain('here it is');
  });

  it('lays files out like the chat: compact cards and bare thumbnails, right-aligned above your bubble, status never cut', async () => {
    const shot: MessageAttachment = { name: 'Screenshot 14.52.png', size: 400_000, mime: 'image/png', kind: 'copied', path: 'attachments/Screenshot 14.52.png', hash: 'sha256:s' };
    const notes: MessageAttachment = { name: 'notes.md', size: 2048, mime: 'text/markdown', kind: 'copied', path: 'attachments/notes.md', hash: 'sha256:n' };
    api.statuses = [
      { path: 'attachments/Screenshot 14.52.png', exists: true, synced: true, onRelay: null },
      { path: 'attachments/notes.md', exists: true, synced: true, onRelay: null },
    ];
    // A 400×300 picture: shown at its own shape, no wider than 240 px.
    const picture = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="teal"/></svg>')}`;
    await render(
      snapshotWith([message({ meta: { kind: 'text', attachments: [shot, notes] }, body: 'this layout is off' })]),
      'dylan',
      vi.fn(),
      async (path) => (path.endsWith('.png') ? picture : null)
    );
    await settle();
    await vi.waitFor(() => expect(host.querySelector('[data-kind="image"] img')).not.toBeNull());
    // Tailwind isn't compiled in these tests, so the layout is checked through its classes.
    const row = host.querySelector<HTMLElement>('[data-testid="message-row"]')!;
    const thumb = row.querySelector<HTMLElement>('[data-testid="attachment-card"][data-kind="image"]')!;
    const img = thumb.querySelector<HTMLImageElement>('img')!;
    expect(img.src).toBe(picture);
    // The picture itself at its own shape, capped, rounded like a bubble: no tile, no caption row.
    expect(img.className).toContain('max-w-[240px]');
    expect(img.className).toContain('max-h-[200px]');
    expect(img.className).toContain('w-auto');
    expect(thumb.querySelector('button')!.className).toContain('rounded-2xl');
    expect(thumb.textContent).toBe('');
    expect(thumb.querySelector<HTMLElement>('button')!.title).toBe('Screenshot 14.52.png · Synced');

    // Other files: the compact card, one per line.
    const card = row.querySelector<HTMLElement>('[data-testid="attachment-card"][data-kind="copied"]')!;
    expect(card.className).toContain('h-[52px]');
    expect(card.className).toContain('w-[260px]');
    const status = card.querySelector<HTMLElement>('[data-testid="attachment-status"]')!;
    expect(status.textContent).toBe('synced');
    // The status never gives way (the size does).
    expect(status.className).toContain('shrink-0');
    expect(status.className).toContain('whitespace-nowrap');

    // Your message: grouped right-aligned, directly above the bubble, in the same column as a reply header.
    const group = row.querySelector<HTMLElement>('[data-testid="message-attachments"]')!;
    expect(group.className).toContain('items-end');
    expect(group.nextElementSibling).toBe(row.querySelector('[data-highlight-target]'));
    expect(group.parentElement!.className).toContain('gap-1');
  });

  it('pending sends show their files as cards while they go', () => {
    const snap = snapshotWith([]);
    const shown = withPendingSends(
      snap,
      [{ localId: 's1', text: '', createdAt: new Date().toISOString(), id: null, attachments: [deck] }],
      'dylan'
    );
    expect(shown.messages[0]!.meta).toMatchObject({ kind: 'text', attachments: [deck], autoBody: true });
  });
});

describe('sendFromComposer with files', () => {
  it('sends the files in meta with a body for older apps when there is no text', async () => {
    const send = vi.fn(async () => 'msg-1');
    const source = { send, requestOwnAgent: vi.fn() };
    const files: MessageAttachment[] = [{ name: 'a.pdf', size: 1, mime: 'application/pdf', kind: 'copied', path: 'attachments/a.pdf' }];
    await sendFromComposer(source, [], '', { agent: null, attach: null }, () => {}, files);
    expect(send).toHaveBeenCalledWith('Shared a.pdf', undefined, undefined, { attachments: files, autoBody: true });
    await sendFromComposer(source, [], 'look', { agent: null, attach: null }, () => {}, files);
    expect(send).toHaveBeenLastCalledWith('look', undefined, undefined, { attachments: files, autoBody: false });
  });
});

describe('+file tags', () => {
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

  const files = [
    { relPath: 'docs/roadmap.md', name: 'roadmap.md', mtimeMs: 1 },
    { relPath: 'attachments/Q3 board deck.pdf', name: 'Q3 board deck.pdf', mtimeMs: 3 },
    { relPath: 'research/interviews.md', name: 'interviews.md', mtimeMs: 2 },
  ];

  async function type(value: string) {
    const textarea = host.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
  }
  async function key(name: string) {
    await act(async () => {
      host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
    });
  }
  const options = () => Array.from(host.querySelectorAll('[role="option"]')).map((o) => o.textContent);

  it('suggests the space’s files on "+", filters as you type, inserts plain or quoted, and closes on Esc', async () => {
    const listFiles = vi.fn(async () => files);
    await act(async () =>
      root.render(<Composer spaceName="#growth" members={[]} agents={[]} skills={[]} onSend={() => {}} listFiles={listFiles} />)
    );
    await type('compare +');
    expect(listFiles).toHaveBeenCalled();
    expect(host.textContent).toContain('Files in this space');
    // Nothing typed yet: most recently changed first.
    expect(options()[0]).toContain('Q3 board deck.pdf');

    await type('compare +road');
    expect(options()).toHaveLength(1);
    expect(options()[0]).toContain('roadmap.md');
    expect(options()[0]).toContain('docs');
    await key('Enter');
    expect(host.querySelector('textarea')!.value).toBe('compare +docs/roadmap.md ');

    // A name with spaces goes in quoted.
    await type('and +q3');
    await key('Tab');
    expect(host.querySelector('textarea')!.value).toBe('and +"attachments/Q3 board deck.pdf" ');

    // Esc closes the list and leaves the text as typed.
    await type('also +inter');
    expect(options()).toHaveLength(1);
    await key('Escape');
    expect(host.querySelector('[role="option"]')).toBeNull();
    expect(host.querySelector('textarea')!.value).toBe('also +inter');
  });

  it('shows tags in messages as file chips that open beside the chat; a missing file is muted', async () => {
    const open = vi.fn();
    const status = vi.fn(async (queries: Array<{ path: string }>) =>
      queries.map((q) => ({ path: q.path, exists: q.path !== 'old/gone.md', synced: null, onRelay: null }))
    );
    const snapshot: RoomSnapshot = {
      name: '#growth',
      ready: true,
      members: [{ id: 'dylan', name: 'Dylan', email: 'd@x.com', role: 'owner', initial: 'D', status: 'here' }],
      agents: [],
      connectors: [],
      skills: [],
      invitesById: {},
      sessionMetaByRun: {},
      sessionEventsByRun: {},
      typingUserIds: [],
      messages: [
        {
          id: 'm1',
          seq: 1,
          authorId: 'dylan',
          createdAt: new Date().toISOString(),
          time: '14:02',
          body: 'See +docs/roadmap.md, +"attachments/Q3 board deck.pdf" and +old/gone.md. Not https://x.com/a+b.md nor +../secret.md or dylan+x@play.local',
          meta: { kind: 'text' },
        },
      ],
    };
    await act(async () =>
      root.render(
        <AttachmentSpaceContext.Provider
          value={{ bindingId: 'bnd_1', spaceRoot: '/s', selfUserId: 'sam', onOpenFile: open, status, thumbnail: async () => null, reveal: () => {}, copyText: () => {} }}
        >
          <RoomTranscript snapshot={snapshot} ownId="sam" />
        </AttachmentSpaceContext.Provider>
      )
    );
    await settle();
    const chips = Array.from(host.querySelectorAll<HTMLButtonElement>('[data-testid="file-tag"]'));
    expect(chips.map((c) => c.dataset.path)).toEqual(['docs/roadmap.md', 'attachments/Q3 board deck.pdf', 'old/gone.md']);
    expect(chips[0]!.textContent).toBe('roadmap.md');
    expect(chips[0]!.title).toBe('docs/roadmap.md');
    expect(chips[1]!.textContent).toBe('Q3 board deck.pdf');
    // The sentence's full stop stays text; the URL, the "..", and the email stay as written.
    const bubble = host.querySelector('[data-highlight-target]')!;
    expect(bubble.textContent).toContain('old/gone.md'.split('/').pop()! + '. Not');
    expect(host.querySelector('a[href="https://x.com/a+b.md"]')).not.toBeNull();
    expect(bubble.textContent).toContain('+../secret.md');
    expect(bubble.textContent).toContain('dylan+x@play.local');

    await act(async () => click(chips[0]!));
    expect(open).toHaveBeenCalledWith('docs/roadmap.md');
    expect(chips[2]!.dataset.missing).toBe('true');
    expect(chips[2]!.disabled).toBe(true);
    expect(chips[2]!.title).toBe('old/gone.md · Not on this computer');
  });
});
