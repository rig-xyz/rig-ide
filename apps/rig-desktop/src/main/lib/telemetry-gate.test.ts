import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two switches in Settings › Privacy, against a build that may send
 * (not a dev build): "Usage data" governs usage events, "Send error reports"
 * governs error events, each on its own.
 */

const mocks = vi.hoisted(() => ({
  kv: new Map<string, string>(),
  fetch: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getVersion: () => '0.4.10', isPackaged: true },
}));

vi.mock('@main/db/kv', () => ({
  KV: class {
    get = async (key: string) => mocks.kv.get(key) ?? null;
    set = async (key: string, value: string) => void mocks.kv.set(key, value);
    del = async (key: string) => void mocks.kv.delete(key);
  },
}));

vi.mock('@main/lib/env', () => ({ env: { build: {}, dev: {}, runtime: {} } }));

type Sent = { event: string; properties: Record<string, unknown> };

function sent(): Sent[] {
  return mocks.fetch.mock.calls
    .filter(([url]) => String(url).includes('/api/telemetry'))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Sent);
}

function events(name: string): Sent[] {
  return sent().filter((s) => s.event === name);
}

let telemetryService: typeof import('./telemetry').telemetryService;
let relay: typeof import('@main/rig/relay-request');
let dailyActive: Sent | undefined;

beforeAll(async () => {
  vi.stubEnv('DEV', false);
  vi.stubGlobal('fetch', mocks.fetch);
  vi.resetModules();
  ({ telemetryService } = await import('./telemetry'));
  relay = await import('@main/rig/relay-request');
  mocks.fetch.mockResolvedValue(new Response('{}'));
  telemetryService.setAgentCliInfoProvider(async () => ({
    claude_cli: '2.1.149',
    codex_cli: '0.160.1',
    codex_source: 'chatgpt_app',
  }));
  await telemetryService.initialize();
  await vi.waitFor(() => expect(events('daily_active_user')).toHaveLength(1));
  dailyActive = events('daily_active_user')[0];
});

beforeEach(() => {
  mocks.fetch.mockClear();
  mocks.fetch.mockResolvedValue(new Response('{}'));
  relay.resetRelayFailuresForTests();
});

afterEach(() => {
  telemetryService.setEnabled(true);
  telemetryService.setErrorReportsEnabled(true);
});

function boom(): Error {
  const error = new Error(
    "ENOENT: no such file, open '/Users/dylan/Rig/Plans/q3.md' for dylan@example.com"
  );
  error.stack = `${error.message}\n    at readDoc (/Users/dylan/Code/rigdash/apps/rig-desktop/out/main/index.js:812:9)`;
  return error;
}

describe('the error reports switch', () => {
  it('daily_active_user says which agent CLIs this computer runs, once a day', async () => {
    expect(dailyActive?.properties).toMatchObject({
      claude_cli: '2.1.149',
      codex_cli: '0.160.1',
      codex_source: 'chatgpt_app',
    });
    await telemetryService.checkAndReportDailyActiveUser();
    expect(events('daily_active_user')).toHaveLength(0);
  });

  it('error events go with usage data off; usage events do not', async () => {
    telemetryService.setEnabled(false);
    telemetryService.trackError('main-uncaught', boom());
    telemetryService.capture('rig_opened', { source: 'recent' });
    await vi.waitFor(() => expect(events('app_error')).toHaveLength(1));
    expect(events('rig_opened')).toHaveLength(0);
  });

  it('with both off nothing goes', async () => {
    telemetryService.setEnabled(false);
    telemetryService.setErrorReportsEnabled(false);
    telemetryService.trackError('main-uncaught', boom());
    telemetryService.trackAgentRunFailed({
      agent: 'codex',
      reason: 'outdated_cli',
      cli_version: '0.147.0',
      cli_source: 'npm',
    });
    telemetryService.capture('rig_opened', { source: 'recent' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent()).toHaveLength(0);
    expect(telemetryService.canSendErrorReports()).toBe(false);
  });

  it('error reports off, usage on: usage events still go', async () => {
    telemetryService.setErrorReportsEnabled(false);
    telemetryService.trackError('main-uncaught', boom());
    telemetryService.capture('rig_opened', { source: 'recent' });
    await vi.waitFor(() => expect(events('rig_opened')).toHaveLength(1));
    expect(events('app_error')).toHaveLength(0);
    expect(mocks.kv.get('errorReports')).toBe('false');
  });

  it('app_error carries the scrubbed message, the top frame and the failed relay request id', async () => {
    mocks.fetch.mockResolvedValueOnce(
      new Response('{}', { status: 502, headers: { 'x-request-id': 'req_abc123' } })
    );
    await relay.fetchRelay('https://tap-relay.fly.dev/v1/me/bindings/bnd_1234/manifest');
    telemetryService.trackError('main-rejection', boom());
    await vi.waitFor(() => expect(events('app_error')).toHaveLength(1));
    const props = events('app_error')[0]!.properties;
    expect(props.message).toBe("ENOENT: no such file, open 'q3.md' for [REDACTED_EMAIL]");
    expect(props.frame).toBe('index.js:812');
    expect(props.req_id).toBe('req_abc123');
    expect(JSON.stringify(props)).not.toMatch(/dylan|Users|Plans/);
  });

  it('agent_run_failed keeps its fields and nothing else', async () => {
    telemetryService.trackAgentRunFailed({
      agent: 'codex',
      reason: 'outdated_cli',
      cli_version: '0.147.0',
      cli_source: 'npm',
      model: 'gpt-6.1-sol',
    });
    await vi.waitFor(() => expect(events('agent_run_failed')).toHaveLength(1));
    expect(events('agent_run_failed')[0]!.properties).toMatchObject({
      agent: 'codex',
      reason: 'outdated_cli',
      cli_version: '0.147.0',
      cli_source: 'npm',
      model: 'gpt-6.1-sol',
    });
  });

  it('sync_problem goes once per space and reason a day', async () => {
    const day = new Date('2026-10-06T10:00:00Z');
    expect(
      telemetryService.trackSyncProblem(
        'space-a',
        { reason: 'conflicts', tapd_version: '0.6.10' },
        day
      )
    ).toBe(true);
    expect(
      telemetryService.trackSyncProblem(
        'space-a',
        { reason: 'conflicts', tapd_version: '0.6.10' },
        day
      )
    ).toBe(false);
    expect(
      telemetryService.trackSyncProblem(
        'space-a',
        { reason: 'apply_error', apply_error_kind: 'eacces', tapd_version: '0.6.10' },
        day
      )
    ).toBe(true);
    expect(
      telemetryService.trackSyncProblem(
        'space-b',
        { reason: 'conflicts', tapd_version: '0.6.10' },
        day
      )
    ).toBe(true);
    const nextDay = new Date('2026-10-07T10:00:00Z');
    expect(
      telemetryService.trackSyncProblem(
        'space-a',
        { reason: 'conflicts', tapd_version: '0.6.10' },
        nextDay
      )
    ).toBe(true);
    await vi.waitFor(() => expect(events('sync_problem')).toHaveLength(4));
    expect(events('sync_problem')[1]!.properties).toMatchObject({
      reason: 'apply_error',
      apply_error_kind: 'eacces',
      tapd_version: '0.6.10',
    });
    expect(JSON.parse(mocks.kv.get('syncProblemsSent')!)).toEqual({
      date: '2026-10-07',
      keys: ['space-a:conflicts'],
    });
  });
});
