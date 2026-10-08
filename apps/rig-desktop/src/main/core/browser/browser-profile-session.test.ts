import { describe, expect, it, vi } from 'vitest';

// A partition's header hook runs inside the session's one onBeforeSendHeaders
// listener, for that partition only, whichever caller configured it first.

type Listener = (details: { url: string; requestHeaders: Record<string, string> }, callback: (r: unknown) => void) => void;
const listeners = new Map<string, Listener>();

vi.mock('electron', () => ({
  app: { getName: () => 'Rig' },
  session: {
    fromPartition: (partition: string) => ({
      setUserAgent: () => {},
      getUserAgent: () => 'Mozilla/5.0',
      setPermissionRequestHandler: () => {},
      setPermissionCheckHandler: () => {},
      webRequest: {
        onBeforeSendHeaders: (listener: Listener) => listeners.set(partition, listener),
        onHeadersReceived: () => {},
        onCompleted: () => {},
        onErrorOccurred: () => {},
      },
    }),
  },
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} } }));

const { configureBrowserProfileSession, setRequestHeadersHook } = await import('./browser-profile-session');

const send = (partition: string, url: string, requestHeaders: Record<string, string> = {}) => {
  let out: unknown;
  listeners.get(partition)!({ url, requestHeaders }, (r) => (out = r));
  return out;
};

describe('setRequestHeadersHook', () => {
  it("runs a partition's hook on its own requests only, set before or after the session", () => {
    configureBrowserProfileSession('persist:files');
    configureBrowserProfileSession('persist:pages');
    setRequestHeadersHook('persist:files', (_url, headers) => {
      headers.Referer = 'https://userig.xyz/';
    });
    expect(send('persist:files', 'https://tile.openstreetmap.org/0/0/0.png')).toEqual({ requestHeaders: { Referer: 'https://userig.xyz/' } });
    expect(send('persist:pages', 'https://tile.openstreetmap.org/0/0/0.png')).toEqual({ requestHeaders: {} });
  });
});
