import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CSSProperties } from 'react';
import ReactDOM from 'react-dom/client';
import { Toaster } from 'sonner';
import { PULSE_QUERY_KEY } from '@renderer/features/home/briefing-spine';
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

// A rig or space was renamed (the Rename dialog, an agent, or a rig.toml edit main pushed to the relay):
// refresh the rig lists, and the pulse briefing, whose prose names rigs (the relay regenerates it once a
// binding changed after it was written).
events.on(rigRenamedChannel, () => {
  void queryClient.invalidateQueries({ queryKey: ['rig', 'recent', 'list'] });
  void queryClient.invalidateQueries({ queryKey: ['rig', 'account', 'workspaces'] });
  void queryClient.invalidateQueries({ queryKey: PULSE_QUERY_KEY });
});

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <RecoveryBoundary scope="Application">
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <App />
        <Toaster
          position="bottom-right"
          theme="system"
          // Toasts wear the app's own popover surface, not sonner's black or
          // white box: its colour variables point at the theme tokens, and the
          // buttons use the app's primary and quiet styles.
          style={
            {
              '--normal-bg': 'var(--bg-1)',
              '--normal-border': 'var(--border-hairline)',
              '--normal-text': 'var(--text-primary)',
              '--border-radius': 'var(--radius-card)',
            } as CSSProperties
          }
          toastOptions={{
            // `theme="system"` follows macOS, not the app's own theme, so with
            // Rig light and macOS dark sonner painted the description near
            // white. The description and close button use the tokens instead.
            classNames: {
              toast: '!shadow-[var(--shadow-float)] !font-sans',
              description: '!text-text-secondary',
              closeButton: '!bg-bg-1 !border-border-hairline !text-text-secondary hover:!text-text-primary',
              actionButton: '!bg-accent !text-accent-ink !rounded-control !h-7 !px-3 !text-xs !font-medium',
              cancelButton:
                '!bg-transparent !text-text-secondary hover:!text-text-primary !rounded-control !h-7 !px-2 !text-xs',
            },
          }}
        />
      </TooltipProvider>
    </QueryClientProvider>
  </RecoveryBoundary>
);
