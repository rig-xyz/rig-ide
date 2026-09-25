import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lane J: a joined-but-not-downloaded space on Home's Spaces card is no
 * dead end — clicking the row downloads (`rig attach`) and opens it; the
 * ⋯ menu carries Download/Locate…; a space's menu and its confirm dialog
 * say "space", not "rig".
 */

const mocks = vi.hoisted(() => ({
  attach: vi.fn(),
  locate: vi.fn(),
  pickDir: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    app: { openSelectDirectoryDialog: (...args: unknown[]) => mocks.pickDir(...args) },
    rig: {
      spacesConnection: { listMembers: async () => ({ success: true, data: [] }) },
      share: { collaborators: async () => ({ success: true, data: [] }) },
      join: {
        attach: (...args: unknown[]) => mocks.attach(...args),
        locate: (...args: unknown[]) => mocks.locate(...args),
      },
    },
  },
  events: { on: vi.fn(() => () => {}) },
}));

import { SpacesCard } from '@renderer/features/home/spaces-card';
import { SPACE_NOT_SET_UP_TOOLTIP, type HomeRigRow } from '@renderer/features/home/home-sections';

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function menuItem(text: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (b) => b.textContent?.trim() === text
  );
}

const relayOnlySpace: HomeRigRow = {
  kind: 'relayOnly',
  bindingId: 'b-gentle',
  isSpace: true,
  name: 'gentle-island',
  disambiguator: null,
  canAutoJoin: true,
  role: 'editor',
  localPath: null,
  localPathPending: false,
  sessions: [],
};

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('SpacesCard — a joined space not on this Mac yet', () => {
  let host: HTMLDivElement;
  let root: Root;
  let opened: string[];

  beforeEach(async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    opened = [];
    mocks.attach.mockReset().mockResolvedValue({
      success: true,
      data: { localPath: '/Rig/gentle-island', syncing: true },
    });
    mocks.locate.mockReset().mockResolvedValue({ success: true, data: { localPath: '/elsewhere/gentle-island' } });
    mocks.pickDir.mockReset().mockResolvedValue('/elsewhere/gentle-island');
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <SpacesCard
            rows={[relayOnlySpace]}
            statusByBinding={new Map()}
            selfUserId={null}
            onOpenPath={(path) => opened.push(path)}
          />
        </QueryClientProvider>
      );
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  function rowButton(): HTMLButtonElement {
    return [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('gentle-island')
    )!;
  }

  async function openMenu(): Promise<void> {
    await act(async () => click(host.querySelector('[aria-label^="More actions for"]')!));
  }

  it('says clicking downloads it, and clicking the row downloads and opens it', async () => {
    expect(host.querySelector(`[aria-label="${SPACE_NOT_SET_UP_TOOLTIP}"]`)).not.toBeNull();
    expect(rowButton().disabled).toBe(false);

    let resolveAttach!: (v: unknown) => void;
    mocks.attach.mockReturnValueOnce(new Promise((resolve) => (resolveAttach = resolve)));
    await act(async () => click(rowButton()));
    expect(rowButton().disabled).toBe(true);
    expect(host.textContent).toContain('Downloading…');

    await act(async () => resolveAttach({ success: true, data: { localPath: '/Rig/gentle-island', syncing: true } }));
    await flush();
    expect(mocks.attach).toHaveBeenCalledWith({ bindingId: 'b-gentle', name: 'gentle-island' });
    expect(opened).toEqual(['/Rig/gentle-island']);
  });

  it('shows the error on the row when the download fails', async () => {
    mocks.attach.mockResolvedValueOnce({ success: false, error: { message: 'Relay unreachable' } });
    await act(async () => click(rowButton()));
    await flush();
    expect(opened).toEqual([]);
    expect(host.textContent).toContain('Relay unreachable');
    expect(rowButton().disabled).toBe(false);
  });

  it('offers Download and Locate… in the ⋯ menu', async () => {
    await openMenu();
    expect(menuItem('Download')).toBeTruthy();
    await act(async () => click(menuItem('Locate…')!));
    await flush();
    expect(mocks.locate).toHaveBeenCalledWith({ bindingId: 'b-gentle', dir: '/elsewhere/gentle-island' });
    expect(opened).toEqual(['/elsewhere/gentle-island']);
  });

  it('says "Leave space…" and the dialog speaks of a space', async () => {
    await openMenu();
    expect(menuItem('Leave rig…')).toBeUndefined();
    await act(async () => click(menuItem('Leave space…')!));
    await flush();
    expect(document.body.textContent).toContain('Leave gentle-island?');
    expect(document.body.textContent).toContain('the space stays for its owner');
    const submit = [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Leave space');
    expect(submit).toBeTruthy();
  });
});
