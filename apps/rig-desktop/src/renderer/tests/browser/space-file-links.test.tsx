import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentFileStatus } from '@shared/rig/attachments';
import type { SyncHealth } from '@shared/rig/sync-health';

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  health: { state: 'stopped' } as SyncHealth,
  get: vi.fn(),
  start: vi.fn(),
}));

vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: mocks.toast }));
vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    app: { openExternal: vi.fn() },
    rig: {
      syncHealth: {
        get: async ({ paths }: { paths: string[] }) => {
          mocks.get(paths);
          return Object.fromEntries(paths.map((p) => [p, mocks.health]));
        },
        start: async ({ path }: { path: string }) => {
          mocks.start(path);
          mocks.health = { state: 'running' };
          return { success: true, data: mocks.health };
        },
      },
    },
  },
  events: { on: () => () => {} },
}));

import { AttachmentSpaceContext, type AttachmentSpace } from '@renderer/features/spaces/components/attachment-cards';
import { SpaceFileLink } from '@renderer/features/spaces/components/space-file-link';
import { SyncHealthNotice } from '@renderer/features/spaces/components/sync-health-notice';
import { richText } from '@renderer/features/spaces/components/transcript-items';
import { SafeMarkdown } from '@renderer/lib/ui/comment-markdown';

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const settle = (ms = 50) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));

let host: HTMLDivElement;
let root: Root;
let present: Set<string>;
let opened: string[];

// Presence checks are shared per space and file for a moment: each test is its own space.
let spaceN = 0;
function space(): AttachmentSpace {
  return {
    bindingId: `bnd_${spaceN}`,
    spaceRoot: '/Users/me/Rig/clear-harbor',
    selfUserId: 'usr_me',
    onOpenFile: (relPath) => opened.push(relPath),
    status: async (files) =>
      files.map((f): AttachmentFileStatus => ({ path: f.path, exists: present.has(f.path), synced: null, onRelay: null })),
    thumbnail: async () => null,
    reveal: () => {},
    copyText: () => {},
  };
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  present = new Set();
  opened = [];
  spaceN += 1;
  mocks.toast.mockReset();
  mocks.get.mockReset();
  mocks.start.mockReset();
  mocks.health = { state: 'stopped' };
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const ANSWER =
  'Done — see [/Users/dtsbourg/Rig/clear-harbor/release-notes-0.4.5.md](/Users/dtsbourg/Rig/clear-harbor/release-notes-0.4.5.md), ' +
  'and `/Users/dtsbourg/Rig/clear-harbor/bugs-0.4.5.md`. Also /Users/dtsbourg/Rig/clear-harbor/rig-wishlist.md';

function renderAnswer(onOpen: (href: string) => void) {
  return act(async () =>
    root.render(
      <AttachmentSpaceContext.Provider value={space()}>
        <SafeMarkdown
          content={ANSWER}
          onOpenPath={onOpen}
          renderFileLink={(parts) => <SpaceFileLink {...parts} onOpen={onOpen} from="Dylan" />}
        />
      </AttachmentSpaceContext.Provider>
    )
  );
}

describe('file links in an agent answer', () => {
  it('shows a teammate’s absolute paths (linked, code or bare) by their path in the space', async () => {
    present = new Set(['release-notes-0.4.5.md', 'bugs-0.4.5.md', 'rig-wishlist.md']);
    const onOpen = vi.fn();
    await renderAnswer(onOpen);
    await settle();
    const links = [...host.querySelectorAll('[data-testid="space-file-link"]')];
    expect(links.map((a) => a.textContent)).toEqual(['release-notes-0.4.5.md', 'bugs-0.4.5.md', 'rig-wishlist.md']);
    expect(links[1]!.querySelector('code')).not.toBeNull();
    expect(host.textContent).not.toContain('/Users/dtsbourg');
    await act(async () => (links[0] as HTMLElement).click());
    expect(onOpen).toHaveBeenCalledWith('/Users/dtsbourg/Rig/clear-harbor/release-notes-0.4.5.md');
  });

  it('says a file isn’t on this computer yet, explains on click, and becomes a link once it lands', async () => {
    present = new Set(['bugs-0.4.5.md', 'rig-wishlist.md']);
    const onOpen = vi.fn();
    await renderAnswer(onOpen);
    await settle();
    const first = () => host.querySelector('[data-testid="space-file-link"]') as HTMLElement;
    expect(first().dataset.missing).toBe('true');
    expect(first().title).toBe('Arriving from Dylan… it will open once it syncs.');
    await act(async () => first().click());
    expect(onOpen).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Not on this computer yet' }));

    present.add('release-notes-0.4.5.md');
    await settle(4500);
    expect(first().dataset.missing).toBeUndefined();
    await act(async () => first().click());
    expect(onOpen).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('leaves a bare path outside the space as plain text', async () => {
    await act(async () =>
      root.render(
        <AttachmentSpaceContext.Provider value={space()}>
          <SafeMarkdown
            content="Config is in /Users/me/.config/thing/settings.json"
            onOpenPath={() => {}}
            renderFileLink={(parts) => <SpaceFileLink {...parts} />}
          />
        </AttachmentSpaceContext.Provider>
      )
    );
    await settle();
    expect(host.querySelector('a')).toBeNull();
    expect(host.textContent).toContain('/Users/me/.config/thing/settings.json');
  });
});

describe('paths in a Room message', () => {
  it('links someone’s absolute path by its path in the space, opening this computer’s copy', async () => {
    present = new Set(['notes/plan.md']);
    await act(async () =>
      root.render(
        <AttachmentSpaceContext.Provider value={space()}>
          <div>{richText('Put it in /Users/hugo/Rig/clear-harbor/notes/plan.md, thanks', 'usr_me')}</div>
        </AttachmentSpaceContext.Provider>
      )
    );
    await settle();
    const link = host.querySelector('[data-testid="space-file-link"]') as HTMLElement;
    expect(link.textContent).toBe('notes/plan.md');
    expect(host.textContent).toBe('Put it in notes/plan.md, thanks');
    await act(async () => link.click());
    expect(opened).toEqual(['notes/plan.md']);
  });
});

describe('SyncHealthNotice', () => {
  it('says when sync isn’t running, and starts it', async () => {
    await act(async () => root.render(<SyncHealthNotice path="/Users/me/Rig/clear-harbor" />));
    await settle();
    const notice = host.querySelector('[data-testid="sync-health-notice"]') as HTMLElement;
    expect(notice.textContent).toContain('Sync isn’t running on this computer. Your files may be out of date.');
    await act(async () => (host.querySelector('[data-testid="sync-health-action"]') as HTMLElement).click());
    await settle();
    expect(mocks.start).toHaveBeenCalledWith('/Users/me/Rig/clear-harbor');
    expect(host.querySelector('[data-testid="sync-health-notice"]')).toBeNull();
  });

  it('says a pause plainly, and nothing while syncing', async () => {
    mocks.health = { state: 'paused', pausedAt: null, reason: null };
    await act(async () => root.render(<SyncHealthNotice path="/r" />));
    await settle();
    expect(host.textContent).toBe('Sync is paused on this computer. Your files may be out of date.Resume');
    mocks.health = { state: 'running' };
    await act(async () => root.render(<SyncHealthNotice path="/other" />));
    await settle();
    expect(host.textContent).toBe('');
  });
});
