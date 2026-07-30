import { observer } from 'mobx-react-lite';
import { useCallback, useEffect } from 'react';
import {
  useTaskViewContext,
  useWorkspace,
  useWorkspaceId,
} from '@renderer/features/tasks/task-view-context';
import { resolveWorkspaceResourcePath } from '@renderer/lib/editor/workspace-resource-path';
import { rpc } from '@renderer/lib/ipc';
import { MarkdownRenderer } from '@renderer/lib/ui/markdown-renderer';
import { Spinner } from '@renderer/lib/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@renderer/lib/ui/toggle-group';
import { DocEditor } from './doc-editor';
import type { DocSaveState, DocTabResource } from './doc-file-sync';

const SAVE_LABEL: Record<DocSaveState, string> = {
  saved: 'Saved',
  saving: 'Saving…',
  unsaved: 'Unsaved',
};

/** Slim top bar: basename, reload pill, save chip, Source/Preview toggle. */
const DocToolbar = observer(function DocToolbar({ resource }: { resource: DocTabResource }) {
  return (
    <div className="flex h-[41px] shrink-0 items-center justify-between gap-2 border-b border-border bg-background-secondary-1 px-2">
      <span
        className="min-w-0 flex-1 truncate pl-1 text-xs text-foreground-muted"
        title={resource.path}
      >
        {resource.basename}
      </span>
      <div className="flex shrink-0 items-center gap-2">
        {resource.hasDiskUpdate && (
          <button
            type="button"
            onClick={() => void resource.reloadFromDisk()}
            title="This file changed on disk. Reload and discard your unsaved changes."
            className="rounded-full border border-border px-2 py-0.5 text-xs text-foreground-muted hover:bg-background-2 hover:text-foreground"
          >
            Updated on disk · Reload
          </button>
        )}
        <span className="text-xs text-foreground-passive">{SAVE_LABEL[resource.saveState]}</span>
        <ToggleGroup
          size="sm"
          multiple={false}
          value={[resource.viewMode]}
          onValueChange={([value]) => {
            if (value === 'source' || value === 'preview') resource.setViewMode(value);
          }}
        >
          <ToggleGroupItem value="source" className="text-xs">
            Source
          </ToggleGroupItem>
          <ToggleGroupItem value="preview" className="text-xs">
            Preview
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
    </div>
  );
});

/**
 * One open doc tab. The CM6 view stays mounted while the tab is hidden or in
 * preview mode so cursor, scroll and undo history survive; `visible` only
 * drives a re-measure and an autosave flush.
 */
export const DocPane = observer(function DocPane({
  resource,
  visible,
}: {
  resource: DocTabResource;
  visible: boolean;
}) {
  const { projectId } = useTaskViewContext();
  const workspaceId = useWorkspaceId();
  const workspacePath = useWorkspace().path;

  useEffect(() => {
    if (visible) {
      // The view was laid out at zero size while hidden.
      resource.editorRef.current?.getView()?.requestMeasure();
      return;
    }
    void resource.flush();
  }, [visible, resource]);

  const handleSave = useCallback(() => {
    void resource.flush();
  }, [resource]);

  const resolveImage = useCallback(
    async (src: string): Promise<string | null> => {
      const imagePath = resolveWorkspaceResourcePath({
        workspacePath,
        containingFilePath: resource.path,
        resourcePath: src,
      });
      if (!imagePath) return null;
      const result = await rpc.workspace.files.readImage(projectId, workspaceId, imagePath);
      return result.success && result.data?.success ? result.data.dataUrl : null;
    },
    [projectId, workspaceId, workspacePath, resource.path]
  );

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <DocToolbar resource={resource} />
      <div className="relative min-h-0 flex-1">
        {resource.isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : resource.loadError ? (
          <div className="px-8 py-8 text-sm text-foreground-destructive">
            Could not open document: {resource.loadError}
          </div>
        ) : (
          <>
            <div
              className="absolute inset-0"
              style={{ visibility: resource.viewMode === 'source' ? 'visible' : 'hidden' }}
            >
              <DocEditor
                ref={resource.editorRef}
                path={resource.path}
                initialContent={resource.content}
                onChange={resource.handleEditorChange}
                onSave={handleSave}
                onSelectionChange={resource.handleSelectionChange}
                extraExtensions={resource.extensionFactories}
              />
            </div>
            {resource.viewMode === 'preview' && (
              <div className="absolute inset-0 overflow-y-auto bg-background-secondary-1">
                <MarkdownRenderer
                  content={resource.content}
                  variant="full"
                  className="mx-auto w-full max-w-3xl px-6 py-8"
                  resolveImage={resolveImage}
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
});
