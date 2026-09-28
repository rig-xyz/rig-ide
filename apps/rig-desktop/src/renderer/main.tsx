import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ReactDOM from 'react-dom/client';
import { Toaster } from 'sonner';
import { RecoveryBoundary } from '@renderer/features/recovery/recovery-boundary';
import { installRendererErrorReporting } from '@renderer/features/recovery/renderer-error-reporting';
import { events } from '@renderer/lib/ipc';
import { TooltipProvider } from '@renderer/lib/ui/tooltip';
import { rigRenamedChannel } from '@shared/rig/workspace';
import { App } from './App';
import './index.css';
// @emdash/chat-ui's own base styles, then this app's host-override binding
// its `--chat-*` contract to our tokens (see chat-theme.css's own header —
// the override wins on specificity regardless of import order, but this
// mirrors emdash-desktop's convention).
import '@emdash/chat-ui/style.css';
import '@renderer/lib/chat/chat-theme.css';

const queryClient = new QueryClient();
installRendererErrorReporting();

// An agent renamed a space: refresh the rig lists, as the Rename dialog does after its own rename.
events.on(rigRenamedChannel, () => {
  void queryClient.invalidateQueries({ queryKey: ['rig', 'recent', 'list'] });
  void queryClient.invalidateQueries({ queryKey: ['rig', 'account', 'workspaces'] });
});

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <RecoveryBoundary scope="Application">
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <App />
        <Toaster position="bottom-right" theme="system" />
      </TooltipProvider>
    </QueryClientProvider>
  </RecoveryBoundary>
);
