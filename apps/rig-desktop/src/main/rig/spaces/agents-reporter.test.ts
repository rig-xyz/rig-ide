import { err, ok } from '@emdash/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentsReporter, reportableAgents, type AgentsReporterDeps } from './agents-reporter';

vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

describe('agents reporter', () => {
  let runnable: string[];
  let account: string | null;
  let enabled: boolean;
  let put: ReturnType<typeof vi.fn<AgentsReporterDeps['put']>>;

  beforeEach(() => {
    vi.useFakeTimers();
    runnable = ['claude', 'codex', 'gemini'];
    account = 'acct-1';
    enabled = true;
    put = vi.fn<AgentsReporterDeps['put']>(async () => ok({ supported: true }));
  });
  afterEach(() => vi.useRealTimers());

  const make = () =>
    createAgentsReporter(
      {
        isEnabled: () => enabled,
        account: async () => account,
        runnable: () => runnable,
        put,
        setTimeout: (cb, ms) => setTimeout(cb, ms),
        clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      },
      1000
    );

  it('keeps only claude and codex, in a stable order', () => {
    expect(reportableAgents(['gemini', 'codex', 'claude'])).toEqual(['claude', 'codex']);
    expect(reportableAgents([])).toEqual([]);
  });

  it('debounces a burst into one report, and sends nothing again until something changes', async () => {
    const reporter = make();
    reporter.nudge();
    reporter.nudge();
    reporter.nudge();
    await vi.advanceTimersByTimeAsync(999);
    expect(put).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(['claude', 'codex']);

    reporter.nudge();
    await vi.advanceTimersByTimeAsync(1000);
    expect(put).toHaveBeenCalledTimes(1);

    runnable = ['codex'];
    reporter.nudge();
    await vi.advanceTimersByTimeAsync(1000);
    expect(put).toHaveBeenLastCalledWith(['codex']);

    // Another account on this device: told again, even with the same set.
    account = 'acct-2';
    reporter.nudge();
    await vi.advanceTimersByTimeAsync(1000);
    expect(put).toHaveBeenCalledTimes(3);
  });

  it('says nothing while signed out or with Spaces off', async () => {
    const reporter = make();
    account = null;
    await reporter.flush();
    enabled = false;
    account = 'acct-1';
    await reporter.flush();
    expect(put).not.toHaveBeenCalled();
    enabled = true;
    await reporter.flush();
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('an older relay (404, unsupported) is not asked again; a failure is retried', async () => {
    put.mockResolvedValueOnce(ok({ supported: false }));
    const reporter = make();
    await reporter.flush();
    await reporter.flush();
    expect(put).toHaveBeenCalledTimes(1);

    runnable = ['claude'];
    put.mockResolvedValueOnce(err({ kind: 'relay', message: 'down' }));
    await reporter.flush();
    await reporter.flush();
    expect(put).toHaveBeenCalledTimes(3);
  });
});

describe('setMyAgents over HTTP', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.doMock('../account', () => ({
      resolveContext: async () => ({ url: 'https://relay.test/', token: 'pat' }),
      isError: (v: unknown) => typeof v === 'object' && v !== null && 'kind' in (v as object),
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('../account');
  });

  it('PUTs the list, and reads a 404 as an older relay', async () => {
    const { createHttpSpacesRelayApi } = await import('./relay-api');
    const api = createHttpSpacesRelayApi();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ agents: ['claude'] }), { status: 200 }));
    expect(await api.setMyAgents!(['claude'])).toEqual(ok({ supported: true }));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://relay.test/v1/me/agents');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ agents: ['claude'] });

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }));
    expect(await api.setMyAgents!(['claude'])).toEqual(ok({ supported: false }));
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 500 }));
    expect((await api.setMyAgents!(['claude'])).success).toBe(false);
  });
});
