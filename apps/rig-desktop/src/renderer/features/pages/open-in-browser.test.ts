import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ openExternal: vi.fn(async () => ({ success: true })), openRigFile: vi.fn(async () => true) }));
vi.mock('@renderer/lib/ipc', () => ({
  rpc: { app: { openExternal: mocks.openExternal }, rig: { pages: { openRigFileInBrowser: mocks.openRigFile } } },
}));

const { openPageInBrowser } = await import('./open-in-browser');

beforeEach(() => {
  mocks.openExternal.mockClear();
  mocks.openRigFile.mockClear();
});

describe('openPageInBrowser', () => {
  it("opens a space's file through main, as the real file", async () => {
    await openPageInBrowser('rig-file://bnd_abc/site/index.html');
    expect(mocks.openRigFile).toHaveBeenCalledWith({ url: 'rig-file://bnd_abc/site/index.html' });
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it('opens a web page as it is', async () => {
    await openPageInBrowser('https://example.com/a');
    expect(mocks.openExternal).toHaveBeenCalledWith('https://example.com/a');
    expect(mocks.openRigFile).not.toHaveBeenCalled();
  });
});
