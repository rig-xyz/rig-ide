import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRefreshMemberReadsOnRosterChange } from '@renderer/features/spaces/roster-refresh';

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

function Harness({ ids, enabled = true }: { ids: string[] | null; enabled?: boolean }) {
  useRefreshMemberReadsOnRosterChange(ids ? ids.map((id) => ({ id })) : null, 'b1', enabled);
  return null;
}

describe('the Room roster keeps the other member lists fresh', () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  let invalidate: ReturnType<typeof vi.fn<(filters: { queryKey: unknown }) => Promise<void>>>;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    client = new QueryClient();
    invalidate = vi.fn(async (_filters: { queryKey: unknown }) => {});
    client.invalidateQueries = invalidate as unknown as QueryClient['invalidateQueries'];
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const render = async (ids: string[] | null, enabled = true) =>
    act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Harness ids={ids} enabled={enabled} />
        </QueryClientProvider>
      );
    });

  const invalidatedKeys = () => invalidate.mock.calls.map(([filters]) => filters.queryKey);

  it('refreshes the members, invites and Home faces reads when someone joins, not on first load or reorder', async () => {
    await render(null);
    await render([]);
    await render(['u1']);
    expect(invalidate).not.toHaveBeenCalled(); // the first roster we see is the baseline
    await render(['u1']);
    expect(invalidate).not.toHaveBeenCalled();

    await render(['u1', 'u-sam']);
    expect(invalidatedKeys()).toEqual([
      ['rig', 'share', 'members'],
      ['rig', 'share', 'invites'],
      ['rig', 'spacesConnection', 'listMembers', 'b1'],
    ]);

    invalidate.mockClear();
    await render(['u-sam', 'u1']);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('does nothing for the scripted demo', async () => {
    await render(['bob'], false);
    await render(['bob', 'alice'], false);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('works without a query client at all', async () => {
    await act(async () => {
      root.render(<Harness ids={['u1']} />);
    });
    await act(async () => {
      root.render(<Harness ids={['u1', 'u2']} />);
    });
  });
});
