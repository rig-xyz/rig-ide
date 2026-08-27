import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (data?: unknown) => void>(),
  emit: vi.fn(),
  openExternal: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: { app: { openExternal: (...args: unknown[]) => mocks.openExternal(...args) } },
  events: {
    emit: (...args: unknown[]) => mocks.emit(...args),
    on: (event: { name: string }, cb: (data?: unknown) => void) => {
      mocks.listeners.set(event.name, cb);
      return () => mocks.listeners.delete(event.name);
    },
  },
}));

vi.mock('@renderer/lib/hooks/use-toast', () => ({
  toast: (...args: unknown[]) => mocks.toast(...args),
}));

import {
  deriveNativeUpdateMenuAction,
  useNativeMenuEvents,
} from '@renderer/features/shell/use-native-menu-events';
import {
  appUndoChannel,
  menuCheckForUpdatesChannel,
  menuCloseTabChannel,
  menuOpenSettingsChannel,
  menuUndoChannel,
  nativeMenuCommandStateChannel,
} from '@shared/events/appEvents';

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

function Harness({
  onSettings,
  onClose,
  onUpdate,
}: {
  onSettings: () => void;
  onClose: () => void;
  onUpdate: () => void;
}) {
  useNativeMenuEvents({
    canOpenSettings: true,
    canCloseTab: true,
    updateAction: 'check',
    onOpenSettings: onSettings,
    onCloseTab: onClose,
    onUpdateAction: onUpdate,
  });
  return <input aria-label="Editable" />;
}

describe('useNativeMenuEvents', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    mocks.listeners.clear();
    mocks.emit.mockReset();
    mocks.openExternal.mockReset();
    mocks.toast.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('routes native Settings, Close Tab, and update events to visible UI actions', async () => {
    const onSettings = vi.fn();
    const onClose = vi.fn();
    const onUpdate = vi.fn();
    await act(async () => {
      root.render(<Harness onSettings={onSettings} onClose={onClose} onUpdate={onUpdate} />);
    });

    await act(async () => {
      mocks.listeners.get(menuOpenSettingsChannel.name)?.();
      mocks.listeners.get(menuCloseTabChannel.name)?.();
      mocks.listeners.get(menuCheckForUpdatesChannel.name)?.();
    });

    expect(onSettings).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it('enables edit commands only while an editable control owns focus', async () => {
    await act(async () => {
      root.render(<Harness onSettings={() => {}} onClose={() => {}} onUpdate={() => {}} />);
    });
    expect(mocks.emit).toHaveBeenCalledWith(
      nativeMenuCommandStateChannel,
      expect.objectContaining({ undo: false, redo: false })
    );

    await act(async () => {
      host.querySelector('input')?.focus();
    });
    expect(mocks.emit).toHaveBeenCalledWith(
      nativeMenuCommandStateChannel,
      expect.objectContaining({ undo: true, redo: true })
    );

    await act(async () => mocks.listeners.get(menuUndoChannel.name)?.());
    expect(mocks.emit).toHaveBeenCalledWith(appUndoChannel, undefined);
  });
});

describe('deriveNativeUpdateMenuAction', () => {
  it('distinguishes unavailable, busy, check, and restart states', () => {
    expect(deriveNativeUpdateMenuAction(false, 'idle')).toBe('unavailable');
    expect(deriveNativeUpdateMenuAction(true, 'checking')).toBe('busy');
    expect(deriveNativeUpdateMenuAction(true, 'downloading')).toBe('busy');
    expect(deriveNativeUpdateMenuAction(true, 'idle')).toBe('check');
    expect(deriveNativeUpdateMenuAction(true, 'error')).toBe('check');
    expect(deriveNativeUpdateMenuAction(true, 'ready')).toBe('restart');
  });
});
