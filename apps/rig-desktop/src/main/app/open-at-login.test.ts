import { describe, expect, it, vi } from 'vitest';
import { applyOpenAtLogin, OPENED_AT_LOGIN_ARG, openedAtLogin } from './open-at-login';

const app = (over: { isPackaged?: boolean; wasOpenedAtLogin?: boolean; inApplications?: boolean } = {}) => ({
  isPackaged: over.isPackaged ?? true,
  isInApplicationsFolder: () => over.inApplications ?? true,
  setLoginItemSettings: vi.fn(),
  getLoginItemSettings: vi.fn(() => ({ wasOpenedAtLogin: over.wasOpenedAtLogin ?? false }) as never),
});

describe('open Rig at login', () => {
  it('tells macOS and Windows, on and off', () => {
    const mac = app();
    expect(applyOpenAtLogin(mac, 'darwin', true)).toBe(true);
    expect(mac.setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: true });
    applyOpenAtLogin(mac, 'darwin', false);
    expect(mac.setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: false });
    const win = app();
    applyOpenAtLogin(win, 'win32', true);
    expect(win.setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: true, args: [OPENED_AT_LOGIN_ARG] });
  });

  it('never registers a development run, or a system it has no login items for', () => {
    const dev = app({ isPackaged: false });
    expect(applyOpenAtLogin(dev, 'darwin', true)).toBe(false);
    expect(dev.setLoginItemSettings).not.toHaveBeenCalled();
    const linux = app();
    expect(applyOpenAtLogin(linux, 'linux', true)).toBe(false);
    expect(linux.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it('on a Mac, registers only the copy in Applications, not one run from a disk image or a build folder', () => {
    const elsewhere = app({ inApplications: false });
    expect(applyOpenAtLogin(elsewhere, 'darwin', true)).toBe(false);
    expect(elsewhere.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it('never stops the app from starting when the system refuses or cannot answer', () => {
    const refusing = app();
    refusing.setLoginItemSettings.mockImplementation(() => {
      throw new Error('Operation not permitted');
    });
    expect(applyOpenAtLogin(refusing, 'darwin', true)).toBe(false);
    const silent = app();
    silent.getLoginItemSettings.mockImplementation(() => {
      throw new Error('no answer');
    });
    // Not knowing: the window opens, as it always did.
    expect(openedAtLogin(silent, 'darwin', [])).toBe(false);
  });

  it('knows a run the login started from one the person started', () => {
    expect(openedAtLogin(app({ wasOpenedAtLogin: true }), 'darwin', [])).toBe(true);
    expect(openedAtLogin(app(), 'darwin', [])).toBe(false);
    expect(openedAtLogin(app(), 'win32', ['Rig.exe', OPENED_AT_LOGIN_ARG])).toBe(true);
    expect(openedAtLogin(app(), 'win32', ['Rig.exe'])).toBe(false);
    expect(openedAtLogin(app({ isPackaged: false, wasOpenedAtLogin: true }), 'darwin', [])).toBe(false);
  });
});
