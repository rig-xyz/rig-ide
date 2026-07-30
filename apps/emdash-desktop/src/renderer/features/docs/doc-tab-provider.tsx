import { observer } from 'mobx-react-lite';
import type {
  ResolvedTab,
  TabContentProps,
  TabEntry,
  TabHandle,
  TabProvider,
  TabViewContext,
} from '@renderer/features/tabs/core/tab-provider';
import { createTabProvider } from '@renderer/features/tabs/core/tab-provider-registry';
import type { TaskTabContext } from '@renderer/features/tabs/core/task-tab-context';
import { resolveWorkspacePath } from '@renderer/features/tasks/stores/workspace-path';
import { commentDecorations } from './comments/comment-decorations';
import { attachDocComments, disposeDocComments } from './comments/comments-store';
import { DocTabResource, type DocPayload } from './doc-file-sync';
import { DocPane } from './doc-pane';
import { DocTabBarItem, DocTabBarItemDragPreview } from './doc-tab-item';

/**
 * The "doc" tab kind: a markdown file opened as a document rather than as
 * source. See `doc-editor.tsx` for the CM6 surface, `doc-file-sync.ts` for
 * autosave / external-edit absorption, and `doc-extensions.ts` for the
 * extension point used by the multiplayer and comments layers.
 */

export interface DocOpenArgs {
  path: string;
}

/** Files that open as a doc tab rather than a source file tab. */
export function isDocPath(path: string): boolean {
  return path.toLowerCase().endsWith('.md');
}

/**
 * Mounts a DocPane per open doc tab and toggles visibility, so each CM6 view
 * (cursor, scroll, undo history) survives tab switches.
 */
const DocTabContent = observer(function DocTabContent({ host }: TabContentProps) {
  const docTabs = host.resolvedTabs.filter(
    (t): t is ResolvedTab<DocTabResource> => t.kind === 'doc'
  );
  const activeTabId = host.resolvedTabs.find((t) => t.isActive)?.tabId ?? null;

  return (
    <>
      {docTabs.map((tab) => {
        const visible = tab.tabId === activeTabId;
        return (
          <div
            key={tab.tabId}
            className="absolute inset-0"
            // Only ever `hidden`: `visible` would escape PaneContent's hidden
            // wrapper and paint this doc over whichever tab kind is active.
            style={{ visibility: visible ? undefined : 'hidden' }}
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore — `inert` is a valid HTML attribute in modern browsers but not yet in React types
            inert={visible ? undefined : ''}
          >
            <DocPane resource={tab.resource} visible={visible} />
          </div>
        );
      })}
    </>
  );
});

export const docTabProvider: TabProvider<'doc', DocPayload, DocTabResource, DocOpenArgs> =
  createTabProvider({
    kind: 'doc',
    mount: 'single',
    resourceKey: (s: DocPayload) => s.path,

    onBeforeOpen(args: DocOpenArgs, ctx: TabViewContext): DocPayload | null {
      const taskCtx = ctx as TaskTabContext;
      return { path: resolveWorkspacePath(taskCtx.workspacePath, args.path) };
    },

    initialize(
      entry: TabEntry<DocPayload>,
      handle: TabHandle,
      ctx: TabViewContext
    ): DocTabResource {
      const taskCtx = ctx as TaskTabContext;
      const resource = new DocTabResource(
        entry.state,
        {
          projectId: taskCtx.projectId,
          workspaceId: taskCtx.workspaceId,
          taskId: taskCtx.taskId,
        },
        handle
      );
      // Comments ride along per tab (not via the global registry) so the layer
      // is scoped to doc tabs and nothing else. Factories are read at mount.
      const comments = attachDocComments(resource);
      resource.extensionFactories.push(() =>
        commentDecorations((id) => comments.setActiveThread(id, 'document'))
      );
      return resource;
    },

    // No onBeforeClose: dispose() flushes pending edits, so closing a doc tab
    // never needs a confirmation dialog.
    dispose(_entry: TabEntry<DocPayload>, resource: DocTabResource): void {
      disposeDocComments(resource);
      resource.dispose();
    },

    TabBarItem: DocTabBarItem,
    TabBarItemDragPreview: DocTabBarItemDragPreview,
    TabContent: DocTabContent,
  });
