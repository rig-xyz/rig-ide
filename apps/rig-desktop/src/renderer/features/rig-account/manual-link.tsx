import { Check, Copy } from 'lucide-react';
import { useClipboard } from '@renderer/lib/hooks/use-clipboard';
import { confirmOpenExternalLink } from '@renderer/lib/open-external-link';
import { Button } from '@renderer/lib/ui/button';

/** The sign-in link to open or copy by hand, for when the browser didn't open it. */
export function ManualLink({ url }: { url: string }) {
  // F fix: reuse `useClipboard` instead of duplicating its copy/reset logic.
  const clipboard = useClipboard();
  return (
    <div className="flex w-full flex-col gap-2 rounded-control border border-border-hairline p-3 text-left">
      <p className="text-xs text-text-muted">
        Didn&apos;t your browser open? Open this link yourself:
      </p>
      <code className="truncate font-mono text-xs text-text-muted">{url}</code>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => clipboard.copy(url)}>
          {clipboard.copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {clipboard.copied ? 'Copied' : 'Copy link'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => confirmOpenExternalLink(url)}>
          Open again
        </Button>
      </div>
    </div>
  );
}
