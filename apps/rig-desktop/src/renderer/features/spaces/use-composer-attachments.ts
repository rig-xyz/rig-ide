import { useCallback, useEffect, useRef, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import type { AttachmentInput, AttachmentSpaceCheck } from '@shared/rig/attachments';
import type { ComposerAttachment } from './attachments';

/**
 * The files waiting in a space's composer (board 19). Chips are checked by
 * main (`rig.attachments.prepare`) whenever the set changes; nothing is
 * copied until `room-view.tsx` commits them on send.
 */

const PREPARE_DEBOUNCE_MS = 120;
let nextId = 0;

export type ComposerAttachments = {
  chips: ComposerAttachment[];
  /** The space as of the last check: usage, quota, and whether attaching is on at all. */
  space: AttachmentSpaceCheck | null;
  /** Attaching is off here (viewer, not linked on this computer, or not a live space): why. */
  disabledReason: string | null;
  /** All chips checked, none blocked, the space can take them. */
  ready: boolean;
  /** Why Send is held back, when it is. */
  holdReason: string | null;
  add: (paths: string[]) => void;
  addFiles: (files: readonly File[]) => Promise<void>;
  pick: () => Promise<void>;
  remove: (id: string) => void;
  rename: (id: string, name: string) => void;
  shareAnyway: (id: string) => void;
  clear: () => ComposerAttachment[];
  /** Puts chips back after a send that didn't go, with the reason on the chip it was about. */
  restore: (chips: ComposerAttachment[], error?: { source?: string; message: string }) => void;
  inputs: () => AttachmentInput[];
};

function toInput(chip: ComposerAttachment): AttachmentInput {
  return { source: chip.source, ...(chip.name ? { name: chip.name } : {}), ...(chip.shareAnyway ? { shareAnyway: true } : {}) };
}

export function useComposerAttachments(bindingId: string, live: boolean): ComposerAttachments {
  const [chips, setChips] = useState<ComposerAttachment[]>([]);
  const [space, setSpace] = useState<AttachmentSpaceCheck | null>(null);
  const [gate, setGate] = useState<{ status: string; message?: string } | null>(null);
  const request = useRef(0);

  // Whether attaching is on here at all (asked once per space; nothing is read).
  useEffect(() => {
    setChips([]);
    setSpace(null);
    setGate(null);
    if (!live) return;
    let alive = true;
    void rpc.rig.attachments
      .prepare({ bindingId, files: [] })
      .then((result) => {
        if (alive) setGate({ status: result.space.status, message: result.space.message });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [bindingId, live]);

  // Re-check whenever what's attached changes (added, removed, renamed, shared anyway).
  const key = chips.map((c) => `${c.source}\u0000${c.name ?? ''}\u0000${c.shareAnyway ? 1 : 0}`).join('\u0001');
  const chipsRef = useRef(chips);
  chipsRef.current = chips;
  useEffect(() => {
    if (chipsRef.current.length === 0) {
      setSpace(null);
      return;
    }
    const id = ++request.current;
    const timer = setTimeout(() => {
      const current = chipsRef.current;
      void rpc.rig.attachments
        .prepare({ bindingId, files: current.map(toInput) })
        .then((result) => {
          if (id !== request.current) return;
          setSpace(result.space);
          setGate({ status: result.space.status, message: result.space.message });
          setChips((now) =>
            now.map((chip) => {
              const index = current.findIndex((c) => c.id === chip.id);
              const verdict = index >= 0 ? result.files[index] : undefined;
              return verdict ? { ...chip, verdict } : chip;
            })
          );
        })
        .catch(() => {});
    }, PREPARE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [key, bindingId]);

  const add = useCallback((paths: string[]) => {
    setChips((current) => {
      const have = new Set(current.map((c) => c.source));
      const fresh = paths.filter((p) => p && !have.has(p)).map((source) => ({ id: `att-${++nextId}`, source }));
      return fresh.length > 0 ? [...current, ...fresh] : current;
    });
  }, []);

  const addFiles = useCallback(
    async (files: readonly File[]) => {
      const paths: string[] = [];
      for (const file of files) {
        const path = window.electronAPI.getPathForFile(file);
        if (path) {
          paths.push(path);
          continue;
        }
        // A pasted image has no file behind it: main writes its bytes to a temp file first.
        if (!file.type.startsWith('image/')) continue;
        const saved = await rpc.rig.attachments
          .savePastedImage({ data: new Uint8Array(await file.arrayBuffer()), mime: file.type })
          .catch(() => null);
        if (saved?.success) paths.push(saved.data.path);
      }
      add(paths);
    },
    [add]
  );

  const pick = useCallback(async () => {
    const paths = await rpc.rig.attachments.pick().catch(() => [] as string[]);
    add(paths);
  }, [add]);

  const update = (id: string, patch: Partial<ComposerAttachment>) =>
    setChips((current) => current.map((c) => (c.id === id ? { ...c, ...patch, error: undefined } : c)));

  const disabledReason = !live
    ? 'Files can only be added in a live space.'
    : gate && gate.status !== 'ok'
      ? (gate.message ?? 'Files can’t be added here.')
      : null;

  // A failed copy (disk full…) doesn't hold Send: sending again is the way to retry.
  const states = chips.map((c) => (c.verdict ? c.verdict.state : 'pending'));
  const holdReason =
    chips.length === 0
      ? null
      : disabledReason
        ? disabledReason
        : states.includes('pending')
          ? 'Checking the files…'
          : states.includes('blocked')
            ? 'Remove the files marked in red to send.'
            : space?.overQuota
              ? (space.quotaMessage ?? 'The space is full.')
              : null;

  return {
    chips,
    space,
    disabledReason,
    ready: holdReason === null,
    holdReason,
    add,
    addFiles,
    pick,
    remove: (id) => setChips((current) => current.filter((c) => c.id !== id)),
    rename: (id, name) => update(id, { name: name.trim() || undefined }),
    shareAnyway: (id) => update(id, { shareAnyway: true }),
    clear: () => {
      const was = chipsRef.current;
      setChips([]);
      return was;
    },
    restore: (restored, error) =>
      setChips((current) => {
        const back = restored.map((c) => ({
          ...c,
          error: error && (error.source === c.source || !error.source) ? error.message : undefined,
        }));
        const have = new Set(back.map((c) => c.source));
        return [...back, ...current.filter((c) => !have.has(c.source))];
      }),
    inputs: () => chipsRef.current.map(toInput),
  } satisfies ComposerAttachments;
}
