import { useCallback, useEffect, useRef, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { quotaCheck, type AttachmentInput, type AttachmentUsage } from '@shared/rig/attachments';
import type { ComposerAttachment } from './attachments';

/**
 * The files waiting in a space's composer (board 19). A chip shows its name
 * and size at once; main's per-file checks (`rig.attachments.prepare`) come
 * back a moment later, and the space's usage (`rig.attachments.usage`, which
 * may wait on the relay) separately. Nothing is copied until `room-view.tsx`
 * commits them on send.
 */

const PREPARE_DEBOUNCE_MS = 120;
let nextId = 0;

export type ComposerAttachments = {
  chips: ComposerAttachment[];
  /** Attaching is off here (viewer, not linked on this computer, or not a live space): why. */
  disabledReason: string | null;
  /** Checks still out (a chip's verdict, or the space's usage): Send waits for them. */
  pending: boolean;
  /** Checked, nothing held back: the files can go. */
  ready: boolean;
  /** Why Send is held back (a red chip, the space's limit), when it is. */
  holdReason: string | null;
  add: (files: Array<{ path: string; size?: number | null }>) => void;
  addFiles: (files: readonly File[]) => Promise<void>;
  pick: () => Promise<void>;
  remove: (id: string) => void;
  rename: (id: string, name: string) => void;
  shareAnyway: (id: string) => void;
  clear: () => ComposerAttachment[];
  /** Puts chips back after a send that didn't go, with the reason on the chip it was about. */
  restore: (chips: ComposerAttachment[], error?: { source?: string; message: string }) => void;
};

function toInput(chip: ComposerAttachment): AttachmentInput {
  return { source: chip.source, ...(chip.name ? { name: chip.name } : {}), ...(chip.shareAnyway ? { shareAnyway: true } : {}) };
}

export function useComposerAttachments(bindingId: string, live: boolean): ComposerAttachments {
  const [chips, setChips] = useState<ComposerAttachment[]>([]);
  const [gate, setGate] = useState<{ status: string; message?: string } | null>(null);
  const [adding, setAdding] = useState(0);
  // The usage answer, and for which `adding` it was asked (a newer set of chips asks again).
  const [usage, setUsage] = useState<{ for: number; value: AttachmentUsage | null } | null>(null);
  const [checkFailed, setCheckFailed] = useState(false);
  const request = useRef(0);

  // Whether attaching is on here at all (asked once per space; nothing is read).
  useEffect(() => {
    setChips([]);
    setGate(null);
    setAdding(0);
    setUsage(null);
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

  // Per-file checks whenever what's attached changes (added, removed, renamed, shared anyway).
  const key = chips.map((c) => `${c.source}\u0000${c.name ?? ''}\u0000${c.shareAnyway ? 1 : 0}`).join('\u0001');
  const chipsRef = useRef(chips);
  chipsRef.current = chips;
  useEffect(() => {
    if (chipsRef.current.length === 0) {
      setAdding(0);
      return;
    }
    const id = ++request.current;
    setCheckFailed(false);
    const timer = setTimeout(() => {
      const current = chipsRef.current;
      void rpc.rig.attachments
        .prepare({ bindingId, files: current.map(toInput) })
        .then((result) => {
          if (id !== request.current) return;
          setGate({ status: result.space.status, message: result.space.message });
          setAdding(result.space.addingBytes);
          setChips((now) =>
            now.map((chip) => {
              const index = current.findIndex((c) => c.id === chip.id);
              const verdict = index >= 0 ? result.files[index] : undefined;
              return verdict ? { ...chip, verdict } : chip;
            })
          );
        })
        .catch(() => {
          if (id === request.current) setCheckFailed(true);
        });
    }, PREPARE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [key, bindingId]);

  // How full the space is, only when something would be copied; main caches it briefly.
  useEffect(() => {
    if (adding <= 0 || !live) return;
    let alive = true;
    void rpc.rig.attachments
      .usage({ bindingId })
      .catch(() => null)
      .then((value) => {
        if (alive) setUsage({ for: adding, value });
      });
    return () => {
      alive = false;
    };
  }, [adding, bindingId, live]);

  const add = useCallback((files: Array<{ path: string; size?: number | null }>) => {
    setChips((current) => {
      const have = new Set(current.map((c) => c.source));
      const fresh = files
        .filter((f) => f.path && !have.has(f.path))
        .map((f) => ({ id: `att-${++nextId}`, source: f.path, ...(typeof f.size === 'number' ? { size: f.size } : {}) }));
      return fresh.length > 0 ? [...current, ...fresh] : current;
    });
  }, []);

  const addFiles = useCallback(
    async (files: readonly File[]) => {
      const found: Array<{ path: string; size: number }> = [];
      for (const file of files) {
        const path = window.electronAPI.getPathForFile(file);
        if (path) {
          found.push({ path, size: file.size });
          continue;
        }
        // A pasted image has no file behind it: main writes its bytes to a temp file first.
        if (!file.type.startsWith('image/')) continue;
        const saved = await rpc.rig.attachments
          .savePastedImage({ data: new Uint8Array(await file.arrayBuffer()), mime: file.type })
          .catch(() => null);
        if (saved?.success) found.push({ path: saved.data.path, size: saved.data.size });
      }
      add(found);
    },
    [add]
  );

  const pick = useCallback(async () => {
    add(await rpc.rig.attachments.pick().catch(() => []));
  }, [add]);

  const update = (id: string, patch: Partial<ComposerAttachment>) =>
    setChips((current) => current.map((c) => (c.id === id ? { ...c, ...patch, error: undefined } : c)));

  const disabledReason = !live
    ? 'Files can only be added in a live space.'
    : gate && gate.status !== 'ok'
      ? (gate.message ?? 'Files can’t be added here.')
      : null;

  const checked = chips.every((c) => c.verdict);
  const usageKnown = adding <= 0 || usage?.for === adding;
  const quota =
    adding > 0 && usageKnown && usage
      ? quotaCheck(usage.value?.usedBytes ?? null, adding, usage.value?.limitBytes ?? Number.POSITIVE_INFINITY)
      : { overQuota: false };
  // A failed copy (disk full…) doesn't hold Send: sending again is the way to retry.
  const holdReason =
    chips.length === 0
      ? null
      : disabledReason
        ? disabledReason
        : checkFailed
          ? 'Couldn’t check the files. Remove one and add it again.'
          : chips.some((c) => c.verdict?.state === 'blocked')
          ? 'Remove the files marked in red to send.'
          : quota.overQuota
            ? (quota.message ?? 'The space is full.')
            : null;
  const pending = chips.length > 0 && !holdReason && (!checked || !usageKnown);

  return {
    chips,
    disabledReason,
    pending,
    ready: chips.length === 0 || (!pending && !holdReason),
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
  } satisfies ComposerAttachments;
}
