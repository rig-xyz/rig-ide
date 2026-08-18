import { useEffect, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { detectByExtension, resolveFileType, SNIFF_BYTES, type DetectedFileType } from './file-type';

export type FileTypeInfo = {
  type: DetectedFileType;
  /**
   * The file's real total size, when the sniff already learned it for
   * free (`readBinary`'s own `size` field) — always populated for
   * `category: 'unsupported'` (there is no extension-only route to that
   * category in this module's design, so it's always reached via the
   * sniff), null for anything resolved by extension alone (markdown,
   * images, known text/grammar — none of which need it from here; the
   * image viewer does its own full read anyway).
   */
  size: number | null;
};

/**
 * The renderer-side half of `file-type.ts`'s two-tier detection: extension
 * first (synchronous — markdown, images, and every known text/config/code
 * extension all resolve on the very first render, no IPC round-trip at
 * all), falling back to `rpc.rig.files.readBinary` for a small sniff ONLY
 * when the extension is genuinely unrecognized. `null` means "still
 * finding out" — only ever true, and only ever briefly, for that
 * unrecognized-extension case.
 */
export function useFileType(path: string): FileTypeInfo | null {
  const [info, setInfo] = useState<FileTypeInfo | null>(() => {
    const byExtension = detectByExtension(path);
    return byExtension ? { type: byExtension, size: null } : null;
  });

  useEffect(() => {
    const byExtension = detectByExtension(path);
    if (byExtension) {
      setInfo({ type: byExtension, size: null });
      return;
    }
    setInfo(null);
    let cancelled = false;
    void rpc.rig.files.readBinary(path, SNIFF_BYTES).then((result) => {
      if (cancelled) return;
      if (!result.success) {
        // Can't even read it to sniff it (permissions, a race with a
        // delete) — the honest answer is the same empty state a genuine
        // binary file gets, not a silent hang on "still finding out."
        setInfo({ type: { category: 'unsupported' }, size: null });
        return;
      }
      const bytes = base64ToBytes(result.data.data);
      setInfo({ type: resolveFileType(path, bytes), size: result.data.size });
    });
    return () => {
      cancelled = true;
    };
    // `path` alone: the caller remounts this component tree on file change
    // (`ArtifactView`'s own `key={path}`, same convention `doc-file-sync.ts`
    // relies on) rather than this effect needing to react to path churn itself.
  }, [path]);

  return info;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
