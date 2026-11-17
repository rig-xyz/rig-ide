import { useEffect, useState } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import { rigFileChangeChannel, type RigFileNode } from '@shared/rig/files';
import {
  readViewManifest,
  viewDataPath,
  viewMetaPath,
  viewNamesFromListing,
  type ViewManifest,
} from '@shared/rig/views';

export type SpaceViews = { rootId: string; names: string[]; info: ViewManifest[] };

async function readText(
  rootId: string,
  relativePath: string,
  maxBytes: number
): Promise<string | null> {
  const read = await rpc.rig.files.read({ rootId, relativePath, maxBytes });
  return read.success && !read.data.truncated ? read.data.content : null;
}

function modifiedAt(nodes: readonly RigFileNode[], relPath: string): number | null {
  for (const node of nodes) {
    if (node.relPath === relPath) return node.mtimeMs ?? null;
    if (node.kind === 'dir' && relPath.startsWith(`${node.relPath}/`))
      return modifiedAt(node.children ?? [], relPath);
  }
  return null;
}

/**
 * The views a space carries right now, each with its manifest (`shared/rig/views.ts`), read from
 * its files and kept current by the file-change signal. Nothing is stored: the folder is the list.
 * Null until the first listing for this root is in, and whenever `rootId` is null (views are off,
 * or no space is open).
 */
export function useSpaceViews(rootId: string | null): SpaceViews | null {
  const [views, setViews] = useState<SpaceViews | null>(null);
  useEffect(() => {
    if (!rootId) return;
    let live = true;
    const read = async () => {
      const result = await rpc.rig.files.list({ rootId });
      if (!live || !result.success) return;
      const names = viewNamesFromListing(result.data);
      const info = await Promise.all(
        names.map(async (name) =>
          readViewManifest({
            name,
            meta: await readText(rootId, viewMetaPath(name), 16_000),
            data: await readText(rootId, viewDataPath(name), 2_000_000),
            dataModifiedMs: modifiedAt(result.data, viewDataPath(name)),
          })
        )
      );
      if (!live) return;
      const same = (current: SpaceViews | null) =>
        current?.rootId === rootId && JSON.stringify(current.info) === JSON.stringify(info);
      setViews((current) => (same(current) ? current : { rootId, names, info }));
    };
    void read();
    void rpc.rig.files.watch({ rootId });
    const off = events.on(rigFileChangeChannel, ({ rootId: changed }) => {
      if (changed === rootId) void read();
    });
    return () => {
      live = false;
      off();
      void rpc.rig.files.unwatch({ rootId });
    };
  }, [rootId]);
  return rootId && views?.rootId === rootId ? views : null;
}
