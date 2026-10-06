import { describe, expect, it } from 'vitest';
import {
  buildProblemReport,
  MAX_REPORT_SPACES,
  MAX_REPORT_TEXT_CHARS,
  REPORT_LOG_BYTES,
} from './problem-report';

const versions = {
  rig: '0.14.5',
  tapd: '0.6.10',
  claude: '2.1.149',
  codex: '0.160.1',
  codexSource: 'chatgpt_app',
};

function build(overrides: Partial<Parameters<typeof buildProblemReport>[0]> = {}) {
  return buildProblemReport({
    text: 'Sync stopped after I renamed a folder',
    appVersion: '0.4.10',
    os: 'darwin 26.0 arm64',
    versions,
    spaces: [],
    failedRequests: [],
    log: '{"level":"info","msg":"hello"}\n',
    ...overrides,
  });
}

describe('buildProblemReport', () => {
  it('has the agreed shape', () => {
    const report = build({
      spaces: [{ name: '#launch', state: 'running' }],
      failedRequests: [
        { reqId: 'req_1', status: 502, method: 'GET', route: '/v1/me/bindings', at: 0 },
      ],
    });
    expect(report).toEqual({
      text: 'Sync stopped after I renamed a folder',
      appVersion: '0.4.10',
      os: 'darwin 26.0 arm64',
      context: {
        rig: '0.14.5',
        tapd: '0.6.10',
        claude: '2.1.149',
        codex: '0.160.1',
        codexSource: 'chatgpt_app',
        spaces: [{ name: '#launch', state: 'running' }],
        failedRequests: [
          {
            reqId: 'req_1',
            status: 502,
            method: 'GET',
            route: '/v1/me/bindings',
            at: '1970-01-01T00:00:00.000Z',
          },
        ],
      },
      log: '{"level":"info","msg":"hello"}\n',
    });
  });

  it('caps the log at about 400 KB on a line boundary, newest lines kept', () => {
    const line = `${'x'.repeat(99)}\n`;
    const log = `first line\n${line.repeat(6_000)}last line\n`;
    const report = build({ log });
    expect(Buffer.byteLength(report.log)).toBeLessThanOrEqual(REPORT_LOG_BYTES);
    expect(report.log.endsWith('last line\n')).toBe(true);
    expect(report.log.startsWith('x')).toBe(true);
    expect(report.log).not.toContain('first line');
  });

  it('caps the text and the spaces', () => {
    const report = build({
      text: 'a'.repeat(MAX_REPORT_TEXT_CHARS + 50),
      spaces: Array.from({ length: MAX_REPORT_SPACES + 10 }, (_, i) => ({
        name: `#s${i}`,
        state: 'running',
      })),
    });
    expect(report.text).toHaveLength(MAX_REPORT_TEXT_CHARS);
    expect(report.context.spaces).toHaveLength(MAX_REPORT_SPACES);
  });

  it('never carries a secret: not in the log, the text, a space error or a name', () => {
    const report = build({
      text: 'my token is rpat_AbCdEfGhIjKlMnOpQrStUvWxYz and it broke',
      spaces: [
        {
          name: '#ops',
          state: 'error',
          lastError:
            "write failed: EACCES open '/Users/dylan/Rig/ops/keys.md' with Bearer abcdefghijklmnop",
        },
      ],
      log: [
        '{"msg":"relay call","headers":{"authorization":"Bearer rpat_AbCdEfGhIjKlMnOpQrStUvWxYz"}}',
        'RIG_RELAY_TOKEN=rpat_ZyXwVuTsRqPoNmLkJiHgFeDc spawn',
        'invite tap_inv_AbCdEfGhIjKlMnOpQrStUvWx accepted by dylan@example.com',
        'OPENAI_API_KEY: sk-abcdefghijklmnopqrstuvwxyz123456',
        '',
      ].join('\n'),
    });
    const all = JSON.stringify(report);
    expect(all).not.toMatch(
      /rpat_|tap_inv_|sk-abcdef|abcdefghijklmnop|dylan@example\.com|\/Users\/dylan/
    );
    expect(report.context.spaces[0]!.lastError).toBe(
      "write failed: EACCES open 'keys.md' with Bearer [REDACTED]"
    );
    // The person's own words keep everything that isn't a secret.
    expect(report.text).toBe('my token is [REDACTED_RIG_TOKEN] and it broke');
  });
});
