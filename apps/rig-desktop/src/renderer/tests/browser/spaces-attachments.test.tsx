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
  pick: vi.fn(async () => [] as string[]),
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
        prepare: async ({ files }: { files: AttachmentInput[] }) => ({
          space: {
            status: api.gate.status,
            message: api.gate.message,
            usedBytes: files.length ? 18 * 1024 * 1024 : null,
            usageSource: files.length ? 'relay' : null,
            limitBytes: 50 * 1024 * 1024,
            addingBytes: 0,
            overQuota: false,
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
        }),
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
    api.savePastedImage.mockClear();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('the paperclip opens the picker; chips show the files and the footer counts them against the space', async () => {
    api.pick.mockResolvedValueOnce(['/Users/me/Q3 board deck.pdf', '/Users/me/whiteboard.jpg']);
    const onSend = vi.fn();
    await act(async () => root.render(<ComposerWithFiles onSend={onSend} />));
    await settle();
    await act(async () => click(host.querySelector('[data-testid="composer-attach"]')!));
    await settle();
    const chips = host.querySelectorAll('[data-testid="attachment-chip"]');
    expect(chips).toHaveLength(2);
    expect(chips[0]!.textContent).toContain('Q3 board deck.pdf');
    expect(host.querySelector('[data-testid="attachment-footer"]')!.textContent).toContain('2 files · 2.0 MB · space 18 MB / 50 MB');

    // Files alone can be sent; the chips go with the message and leave the composer.
    const send = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.startsWith('Send'))!;
    expect(send.disabled).toBe(false);
    await act(async () => click(send));
    expect(onSend).toHaveBeenCalledOnce();
    const [text, ctx] = onSend.mock.calls[0]! as [string, ComposerSendContext];
    expect(text).toBe('');
    expect(ctx.files?.map((f) => f.source)).toEqual(['/Users/me/Q3 board deck.pdf', '/Users/me/whiteboard.jpg']);
    expect(host.querySelectorAll('[data-testid="attachment-chip"]')).toHaveLength(0);
  });

  it('a red chip holds Send until it is removed', async () => {
    api.pick.mockResolvedValueOnce(['/Users/me/demo.mp4']);
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
    api.pick.mockResolvedValueOnce(['/Users/me/deploy.pem']);
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

  async function render(snapshot: RoomSnapshot, ownId: string, onOpenFile = vi.fn()) {
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
            thumbnail: async () => null,
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

  it('your files say Syncing… until the sync daemon has them; a click opens one beside the chat', async () => {
    api.statuses = [{ path: 'attachments/Q3 board deck.pdf', exists: true, synced: false, onRelay: null }];
    const open = await render(snapshotWith([message({})]), 'dylan');
    const cards = host.querySelectorAll<HTMLElement>('[data-testid="attachment-card"]');
    expect(cards).toHaveLength(2);
    expect(cards[0]!.textContent).toContain('18 pages · 4.2 MB');
    expect(cards[0]!.textContent).toContain('Syncing…');
    expect(cards[1]!.textContent).toContain('Only on your computer');
    // Files only: the "Shared 2 files" text for older apps isn't shown twice.
    expect(host.querySelector('[data-testid="message-row"]')!.textContent).not.toContain('Shared 2 files');
    await act(async () => click(cards[0]!));
    expect(open).toHaveBeenCalledWith('attachments/Q3 board deck.pdf');
    // Asked about space paths only, never the local-only file.
    expect(api.status).toHaveBeenLastCalledWith({ bindingId: 'bnd_1', files: [{ path: 'attachments/Q3 board deck.pdf', hash: 'sha256:d' }], withRelay: false });
  });

  it("others see Arriving from the sender until the file is here, and whose computer a local-only file is on", async () => {
    api.statuses = [{ path: 'attachments/Q3 board deck.pdf', exists: false, synced: null, onRelay: true }];
    await render(snapshotWith([message({})]), 'sam');
    const cards = host.querySelectorAll<HTMLElement>('[data-testid="attachment-card"]');
    expect(cards[0]!.textContent).toContain('Arriving from Dylan…');
    expect(cards[1]!.textContent).toContain('Only on Dylan’s computer');
  });

  it('a message sent over the quota says so on your card', async () => {
    api.statuses = [{ path: 'attachments/Q3 board deck.pdf', exists: true, synced: false, onRelay: null, notSynced: 'overQuota' }];
    await render(snapshotWith([message({ meta: { kind: 'text', attachments: [deck] } , body: 'here it is' })]), 'dylan');
    expect(host.textContent).toContain('Not synced: over the space’s 50 MB');
    expect(host.textContent).toContain('here it is');
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
