import { useCallback, useEffect, useState } from 'react';
import { toast } from '@renderer/lib/hooks/use-toast';
import { events, rpc } from '@renderer/lib/ipc';
import {
  appRedoChannel,
  appUndoChannel,
  menuCheckForUpdatesChannel,
  menuCloseTabChannel,
  menuGiveFeedbackChannel,
  menuOpenSettingsChannel,
  menuRedoChannel,
  menuUndoChannel,
  nativeMenuCommandStateChannel,
  type NativeMenuCommandState,
  type NativeMenuUpdateAction,
} from '@shared/events/appEvents';
import { RIG_ISSUES_NEW_URL } from '@shared/urls';
import type { UpdateStatus } from './update-status';

const DISABLED_STATE: NativeMenuCommandState = {
  settings: false,
  closeTab: false,
  undo: false,
  redo: false,
  update: 'unavailable',
  feedback: false,
};

const NON_EDITING_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'radio',
  'range',
  'reset',
  'submit',
]);

export function isEditableMenuTarget(target: Element | null): boolean {
  if (!target) return false;
  if (target instanceof HTMLTextAreaElement) return !target.disabled && !target.readOnly;
  if (target instanceof HTMLInputElement) {
    return !target.disabled && !target.readOnly && !NON_EDITING_INPUT_TYPES.has(target.type);
  }
  return Boolean(target.closest('[contenteditable="true"], .cm-editor'));
}

export function deriveNativeUpdateMenuAction(
  supported: boolean | undefined,
  status: UpdateStatus
): NativeMenuUpdateAction {
  if (supported !== true) return 'unavailable';
  if (status === 'ready') return 'restart';
  if (status === 'checking' || status === 'downloading') return 'busy';
  return 'check';
}

export function useNativeMenuEvents({
  canOpenSettings,
  canCloseTab,
  updateAction,
  onOpenSettings,
  onCloseTab,
  onUpdateAction,
}: {
  canOpenSettings: boolean;
  canCloseTab: boolean;
  updateAction: NativeMenuUpdateAction;
  onOpenSettings: () => void;
  onCloseTab: () => void;
  onUpdateAction: () => void;
}): void {
  const [editing, setEditing] = useState(() => isEditableMenuTarget(document.activeElement));

  useEffect(() => {
    let timer: number | null = null;
    const sync = () => setEditing(isEditableMenuTarget(document.activeElement));
    const scheduleSync = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(sync, 0);
    };
    document.addEventListener('focusin', sync);
    document.addEventListener('focusout', scheduleSync);
    return () => {
      document.removeEventListener('focusin', sync);
      document.removeEventListener('focusout', scheduleSync);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  const giveFeedback = useCallback(() => {
    void rpc.app
      .openExternal(RIG_ISSUES_NEW_URL)
      .then((result) => {
        if (result.success) return;
        toast({
          title: "Couldn't open feedback",
          description: result.error,
          variant: 'destructive',
        });
      })
      .catch(() => {
        toast({
          title: "Couldn't open feedback",
          description: 'Open the Help menu and try again.',
          variant: 'destructive',
        });
      });
  }, []);

  useEffect(() => {
    const offs = [
      events.on(menuOpenSettingsChannel, () => {
        if (canOpenSettings) onOpenSettings();
      }),
      events.on(menuCloseTabChannel, () => {
        if (canCloseTab) onCloseTab();
      }),
      events.on(menuUndoChannel, () => {
        if (editing) events.emit(appUndoChannel, undefined);
      }),
      events.on(menuRedoChannel, () => {
        if (editing) events.emit(appRedoChannel, undefined);
      }),
      events.on(menuCheckForUpdatesChannel, () => {
        if (updateAction === 'check' || updateAction === 'restart') onUpdateAction();
      }),
      events.on(menuGiveFeedbackChannel, giveFeedback),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [
    canOpenSettings,
    canCloseTab,
    editing,
    giveFeedback,
    onCloseTab,
    onOpenSettings,
    onUpdateAction,
    updateAction,
  ]);

  useEffect(() => {
    events.emit(nativeMenuCommandStateChannel, {
      settings: canOpenSettings,
      closeTab: canCloseTab,
      undo: editing,
      redo: editing,
      update: updateAction,
      feedback: true,
    });
  }, [canOpenSettings, canCloseTab, editing, updateAction]);

  useEffect(
    () => () => {
      events.emit(nativeMenuCommandStateChannel, DISABLED_STATE);
    },
    []
  );
}
