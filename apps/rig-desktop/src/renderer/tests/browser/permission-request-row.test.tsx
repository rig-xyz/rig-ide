import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionRequestRow } from '@renderer/features/docs/comments/comments-margin';
import type { DocCommentsStore } from '@renderer/features/docs/comments/comments-store';
import type { RigCommentPermissionRequest } from '@shared/rig/comments';

/**
 * Card-level coverage for the auto-approve round's honesty fix: the
 * provider's own `allow_always` option (Claude's "Yes, don't ask again")
 * used to be rendered as a real button that invoked that option id directly
 * — a promise the very next `@mention`'s fresh headless session would
 * silently break, since "always allow" is session-scoped and every mention
 * starts a new one (see `comment-agent-auto-approve.ts`'s module doc). The
 * card now never renders or invokes `allow_always` at all: a request that
 * offers it instead gets one quiet text link that turns on the real,
 * persistent "Auto-approve agent actions" app setting and grants THIS
 * request through its own `allow_once` option.
 *
 * `store` is a minimal stand-in — `PermissionRequestRow` only ever reads
 * `isPending`/`resolveAgentPermission` off it — rather than a real
 * `DocCommentsStore`, which needs a live `DocTabResource` and comments RPCs
 * this leaf component never touches.
 */

const mocks = vi.hoisted(() => ({
  settingsSet: vi.fn<(args: unknown) => Promise<unknown>>(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    rig: {
      settings: {
        set: (...args: unknown[]) => mocks.settingsSet(args[0]),
      },
    },
  },
  // `comments-margin.tsx` pulls in `comments-store.ts` for `DocCommentsStore`'s
  // type (a value import, not `import type`), which itself imports `events`
  // off this same module — never called here, since the fake store below
  // bypasses `DocCommentsStore` entirely, but the module still needs to
  // resolve at import time.
  events: { on: vi.fn(() => () => {}) },
}));

function fakeStore(resolveAgentPermission: (rootId: string, requestId: string, optionId: string) => void): DocCommentsStore {
  return {
    isPending: () => false,
    resolveAgentPermission,
  } as unknown as DocCommentsStore;
}

const requestWithPersistentOption: RigCommentPermissionRequest = {
  requestId: 'req_1',
  title: 'Run command',
  detail: { kind: 'execute', command: 'npm test' },
  options: [
    { optionId: 'opt_allow_once', name: 'Yes', kind: 'allow_once' },
    { optionId: 'opt_allow_always', name: "Yes, don't ask again", kind: 'allow_always' },
    { optionId: 'opt_reject', name: 'No', kind: 'reject_once' },
  ],
};

function buttons(host: HTMLElement): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll('button'));
}

describe('PermissionRequestRow — the always-allow replacement', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    mocks.settingsSet.mockReset().mockResolvedValue({ success: true, data: undefined });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('never renders a button carrying the provider\'s own allow_always option', async () => {
    await act(async () => {
      root.render(
        <PermissionRequestRow
          store={fakeStore(vi.fn())}
          rootId="root_1"
          request={requestWithPersistentOption}
          workspaceRoot={null}
        />
      );
    });
    const labels = buttons(host).map((button) => button.textContent);
    expect(labels).not.toContain("Yes, don't ask again");
  });

  it('renders the quiet settings-link text when the request offers allow_always', async () => {
    await act(async () => {
      root.render(
        <PermissionRequestRow
          store={fakeStore(vi.fn())}
          rootId="root_1"
          request={requestWithPersistentOption}
          workspaceRoot={null}
        />
      );
    });
    expect(host.textContent).toContain('Always allow — turn on auto-approve for agents');
  });

  it('does not render the settings link when the request offers no allow_always option', async () => {
    const requestWithoutPersistentOption: RigCommentPermissionRequest = {
      ...requestWithPersistentOption,
      options: requestWithPersistentOption.options.filter((option) => option.kind !== 'allow_always'),
    };
    await act(async () => {
      root.render(
        <PermissionRequestRow
          store={fakeStore(vi.fn())}
          rootId="root_1"
          request={requestWithoutPersistentOption}
          workspaceRoot={null}
        />
      );
    });
    expect(host.textContent).not.toContain('Always allow');
  });

  it('clicking the settings link turns on the global setting and resolves the request with the plain allow_once option — never allow_always', async () => {
    const resolveAgentPermission = vi.fn();
    await act(async () => {
      root.render(
        <PermissionRequestRow
          store={fakeStore(resolveAgentPermission)}
          rootId="root_1"
          request={requestWithPersistentOption}
          workspaceRoot={null}
        />
      );
    });

    const link = buttons(host).find((button) =>
      button.textContent?.includes('Always allow — turn on auto-approve for agents')
    );
    expect(link).toBeDefined();

    await act(async () => {
      link!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mocks.settingsSet).toHaveBeenCalledExactlyOnceWith({ autoApproveAgentActions: true });
    expect(resolveAgentPermission).toHaveBeenCalledExactlyOnceWith('root_1', 'req_1', 'opt_allow_once');
  });
});
