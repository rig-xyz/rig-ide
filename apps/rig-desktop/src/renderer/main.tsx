import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ReactDOM from 'react-dom/client';
import { Toaster } from 'sonner';
import { TooltipProvider } from '@renderer/lib/ui/tooltip';
import { App } from './App';
import './index.css';
// @emdash/chat-ui's own base styles, then this app's host-override binding
// its `--chat-*` contract to our tokens (see chat-theme.css's own header —
// the override wins on specificity regardless of import order, but this
// mirrors emdash-desktop's convention).
import '@emdash/chat-ui/style.css';
import '@renderer/lib/chat/chat-theme.css';

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <App />
      <Toaster position="bottom-right" theme="system" />
    </TooltipProvider>
  </QueryClientProvider>
);
