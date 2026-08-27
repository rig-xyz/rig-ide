import type { NativeMenuCommandState, NativeMenuUpdateAction } from '@shared/events/appEvents';

export const NATIVE_MENU_ITEM_IDS = {
  settings: 'native-settings',
  closeTab: 'native-close-tab',
  undo: 'native-undo',
  redo: 'native-redo',
  update: 'native-update',
  feedback: 'native-feedback',
} as const;

export const DISABLED_NATIVE_MENU_STATE: NativeMenuCommandState = {
  settings: false,
  closeTab: false,
  undo: false,
  redo: false,
  update: 'unavailable',
  feedback: false,
};

export type NativeMenuItemChange = {
  id: (typeof NATIVE_MENU_ITEM_IDS)[keyof typeof NATIVE_MENU_ITEM_IDS];
  enabled: boolean;
  label?: string;
};

function updateItemChange(update: NativeMenuUpdateAction): NativeMenuItemChange {
  return {
    id: NATIVE_MENU_ITEM_IDS.update,
    enabled: update === 'check' || update === 'restart',
    label: update === 'restart' ? 'Restart to Update' : 'Check for Updates\u2026',
  };
}

/** Pure projection from renderer capability state to mutable Electron menu fields. */
export function deriveNativeMenuItemChanges(state: NativeMenuCommandState): NativeMenuItemChange[] {
  return [
    { id: NATIVE_MENU_ITEM_IDS.settings, enabled: state.settings },
    { id: NATIVE_MENU_ITEM_IDS.closeTab, enabled: state.closeTab },
    { id: NATIVE_MENU_ITEM_IDS.undo, enabled: state.undo },
    { id: NATIVE_MENU_ITEM_IDS.redo, enabled: state.redo },
    updateItemChange(state.update),
    { id: NATIVE_MENU_ITEM_IDS.feedback, enabled: state.feedback },
  ];
}
