import { observer } from 'mobx-react-lite';
import { SidebarConversationsList } from '@renderer/features/conversations/sidebar-conversations-list';
import { ThreadPane } from '@renderer/features/conversations/threads/thread-pane';
import { useWorkspaceViewModel } from '@renderer/features/tasks/task-view-context';
import { ShowHide } from '@renderer/lib/ui/show-hide';
import { ChangesPanel } from '../diff-view/changes-panel/changes-panel';
import { EditorFileTree } from '../editor/editor-file-tree';
import { RigTasksPanel } from './rig-tasks-panel';

export const TaskSidebar = observer(function TaskSidebar() {
  const taskView = useWorkspaceViewModel();
  const { isSidebarCollapsed, sidebarTab: activeTab } = taskView;

  return (
    <div
      className="h-full min-h-0 overflow-hidden"
      style={isSidebarCollapsed ? { display: 'none' } : undefined}
    >
      <ShowHide visible={activeTab === 'conversations'}>
        <SidebarConversationsList />
      </ShowHide>
      <ShowHide visible={taskView.isChangesPanelVisible} lazy>
        <ChangesPanel />
      </ShowHide>
      <ShowHide visible={activeTab === 'files'}>
        <EditorFileTree />
      </ShowHide>
      <ShowHide visible={activeTab === 'rig-tasks'} lazy>
        <RigTasksPanel />
      </ShowHide>
      <ShowHide visible={activeTab === 'thread'} lazy>
        <ThreadPane />
      </ShowHide>
    </div>
  );
});
