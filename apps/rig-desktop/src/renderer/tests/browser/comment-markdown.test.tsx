import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ openExternal: vi.fn() }));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: { app: { openExternal: mocks.openExternal } },
}));

import { SafeMarkdown } from '@renderer/lib/ui/comment-markdown';

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

/**
 * `SafeMarkdown`'s `rigfile:` interception (Home pulse's file-mention
 * round, `features/home/pulse-file-mentions.ts`'s own output): a
 * `rigfile:<bindingId>/<relPath>` href must route through `onOpenRigFile`,
 * never `rpc.app.openExternal` — that RPC is only ever meant for a REAL
 * external URL, and this is the one place that boundary is actually
 * enforced.
 */
describe('SafeMarkdown — rigfile: link interception', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    mocks.openExternal.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('routes a rigfile: link to onOpenRigFile, decoded, and never calls openExternal', async () => {
    const onOpenRigFile = vi.fn();
    await act(async () => {
      root.render(
        <SafeMarkdown
          content="see [notes.md](rigfile:bind123/docs%2Fnotes.md) now"
          onOpenRigFile={onOpenRigFile}
        />
      );
    });

    const link = host.querySelector('a');
    expect(link).not.toBeNull();
    await act(async () => link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));

    expect(onOpenRigFile).toHaveBeenCalledTimes(1);
    expect(onOpenRigFile).toHaveBeenCalledWith('bind123', 'docs/notes.md');
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it('still routes a real external link to openExternal, and never calls onOpenRigFile', async () => {
    const onOpenRigFile = vi.fn();
    await act(async () => {
      root.render(
        <SafeMarkdown content="see [the docs](https://example.com/docs) now" onOpenRigFile={onOpenRigFile} />
      );
    });

    const link = host.querySelector('a');
    await act(async () => link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));

    expect(mocks.openExternal).toHaveBeenCalledTimes(1);
    expect(mocks.openExternal).toHaveBeenCalledWith('https://example.com/docs');
    expect(onOpenRigFile).not.toHaveBeenCalled();
  });

  it('never calls openExternal for a rigfile: link even when no onOpenRigFile handler is given', async () => {
    await act(async () => {
      root.render(<SafeMarkdown content="see [notes.md](rigfile:bind123/notes.md) now" />);
    });

    const link = host.querySelector('a');
    await act(async () => link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));

    expect(mocks.openExternal).not.toHaveBeenCalled();
  });
});
