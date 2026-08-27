import { describe, expect, it } from 'vitest';
import {
  deriveNativeMenuItemChanges,
  DISABLED_NATIVE_MENU_STATE,
  NATIVE_MENU_ITEM_IDS,
} from './native-menu-state';

describe('deriveNativeMenuItemChanges', () => {
  it('keeps renderer-owned commands disabled before the renderer is ready', () => {
    expect(deriveNativeMenuItemChanges(DISABLED_NATIVE_MENU_STATE)).toEqual([
      { id: NATIVE_MENU_ITEM_IDS.settings, enabled: false },
      { id: NATIVE_MENU_ITEM_IDS.closeTab, enabled: false },
      { id: NATIVE_MENU_ITEM_IDS.undo, enabled: false },
      { id: NATIVE_MENU_ITEM_IDS.redo, enabled: false },
      {
        id: NATIVE_MENU_ITEM_IDS.update,
        enabled: false,
        label: 'Check for Updates\u2026',
      },
      { id: NATIVE_MENU_ITEM_IDS.feedback, enabled: false },
    ]);
  });

  it('enables available actions and relabels a ready update', () => {
    const changes = deriveNativeMenuItemChanges({
      settings: true,
      closeTab: true,
      undo: true,
      redo: false,
      update: 'restart',
      feedback: true,
    });

    expect(changes).toContainEqual({
      id: NATIVE_MENU_ITEM_IDS.update,
      enabled: true,
      label: 'Restart to Update',
    });
    expect(changes).toContainEqual({ id: NATIVE_MENU_ITEM_IDS.closeTab, enabled: true });
    expect(changes).toContainEqual({ id: NATIVE_MENU_ITEM_IDS.redo, enabled: false });
  });

  it('disables update commands while a check or download is in flight', () => {
    const update = deriveNativeMenuItemChanges({
      ...DISABLED_NATIVE_MENU_STATE,
      update: 'busy',
    }).find((change) => change.id === NATIVE_MENU_ITEM_IDS.update);

    expect(update).toEqual({
      id: NATIVE_MENU_ITEM_IDS.update,
      enabled: false,
      label: 'Check for Updates\u2026',
    });
  });
});
