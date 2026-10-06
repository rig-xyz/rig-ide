import { describe, expect, it } from 'vitest';
import { redactAll, redactPii, redactSecrets } from './redact';

describe('redactSecrets', () => {
  it('redacts authorization headers', () => {
    expect(redactSecrets('authorization: Bearer abc123')).toContain('[REDACTED]');
  });

  it('redacts api_key= assignment', () => {
    expect(redactSecrets('api_key=super-secret-key')).toContain('[REDACTED]');
  });

  it('redacts token field', () => {
    expect(redactSecrets('token: ghp_123456')).toContain('[REDACTED]');
  });

  it('redacts GitHub tokens', () => {
    expect(redactSecrets('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toContain(
      '[REDACTED_GITHUB_TOKEN]'
    );
  });

  it('redacts OpenAI keys', () => {
    expect(redactSecrets('sk-abcdefghijklmnopqrstuvwxyz123456')).toContain('[REDACTED_OPENAI_KEY]');
  });

  it('redacts Rig relay tokens and secrets wherever they appear', () => {
    const line =
      'RIG_RELAY_TOKEN=rpat_AbCdEfGhIjKlMnOpQrStUvWxYz012345 {"relayToken":"rsk_AbCdEfGhIjKlMnOpQrSt"} ' +
      'GET /v1/invites/tap_inv_AbCdEfGhIjKlMnOpQrStUvWx tap_cap_AbCdEfGhIjKlMnOpQrSt tap_shr_AbCdEfGhIjKlMnOpQrSt';
    const redacted = redactSecrets(line);
    expect(redacted).not.toMatch(/rpat_|rsk_|tap_inv_|tap_cap_|tap_shr_/);
    expect(redacted.match(/\[REDACTED_RIG_TOKEN\]/g)).toHaveLength(5);
  });

  it('redacts a bearer credential logged without a header name', () => {
    const redacted = redactSecrets('fetch failed with headers Bearer abc.def-ghi_jkl123 and more');
    expect(redacted).toBe('fetch failed with headers Bearer [REDACTED] and more');
  });

  it('leaves the word bearer in prose alone', () => {
    expect(redactSecrets('the bearer of bad news')).toBe('the bearer of bad news');
  });

  it('redacts PEM blocks', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpA\n-----END RSA PRIVATE KEY-----';
    expect(redactSecrets(pem)).toBe('[REDACTED_PEM_BLOCK]');
  });
});

describe('redactPii', () => {
  it('redacts email addresses', () => {
    expect(redactPii('person@example.com')).toContain('[REDACTED_EMAIL]');
  });

  it('redacts /Users/ paths', () => {
    expect(redactPii('/Users/alice/projects')).toContain('[REDACTED_USER]');
  });

  it('redacts /home/ paths', () => {
    expect(redactPii('/home/bob/work')).toContain('[REDACTED_USER]');
  });

  it('redacts IPv4 addresses', () => {
    expect(redactPii('192.168.1.25')).toContain('[REDACTED_IP]');
  });

  it('redacts credentials in DSNs', () => {
    expect(redactPii('postgres://user:pass@host/db')).toContain('[REDACTED_CREDENTIALS]');
  });
});

describe('redactAll', () => {
  it('applies both secret and PII redaction', () => {
    const input = 'token: abc\nemail person@example.com';
    const result = redactAll(input);
    expect(result).toContain('[REDACTED]');
    expect(result).toContain('[REDACTED_EMAIL]');
  });
});
