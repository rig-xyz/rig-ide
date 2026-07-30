import { FileText } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import type { ResolvedTab, TabBarItemProps } from '@renderer/features/tabs/core/tab-provider';
import {
  GenericTabDragPreview,
  GenericTabItem,
} from '@renderer/features/tabs/tab-bar/generic-tab-item';
import type { DocTabResource } from './doc-file-sync';

const docIcon = (
  <span className="shrink-0 [&>svg]:h-3 [&>svg]:w-3">
    <FileText />
  </span>
);

export const DocTabBarItem = observer(function DocTabBarItem({
  tab,
  host,
  ctx,
}: TabBarItemProps<DocTabResource>) {
  const resource = tab.resource;
  return (
    <GenericTabItem
      tab={tab}
      host={host}
      ctx={ctx}
      label={resource.basename}
      tooltip={resource.path}
      preSlot={docIcon}
      hasError={!!resource.loadError}
      statusSlot={
        resource.saveState === 'unsaved' ? (
          <div
            className="size-2 rounded-full bg-foreground group-hover:opacity-0"
            title="Unsaved changes"
          />
        ) : undefined
      }
    />
  );
});

export function DocTabBarItemDragPreview({ tab }: { tab: ResolvedTab<DocTabResource> }) {
  return <GenericTabDragPreview preSlot={docIcon} label={tab.resource.basename} />;
}
