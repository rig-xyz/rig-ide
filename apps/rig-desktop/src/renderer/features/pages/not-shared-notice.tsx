import { X } from 'lucide-react';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { pageNoun } from '@shared/pages/page-access';
import type { SignInSite } from '@shared/pages/sign-in-sites';
import { signInFlow } from './sign-in-flow';
import { browserLabel, recordFor, useSignIns } from './use-sign-ins';

/**
 * "This Doc isn't shared with <account>" (canvas board 18, case 8): a card
 * over the top of the page, not a cover; the page stays usable behind it.
 * The account is rig's sign-in for the site, else the connected profile's.
 */
export function NotSharedNotice({ site, pageUrl, onHide }: { site: SignInSite; pageUrl: string; onHide: () => void }) {
  const list = useSignIns();
  const record = recordFor(list.data, site.id);
  const account = record?.account ?? list.data?.connection?.email ?? null;
  const browser = list.data?.connection?.browserName ?? browserLabel(list.data, record?.browser);
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center p-3" data-testid="not-shared">
      <div className="bg-bg-1 border-border-hairline shadow-float pointer-events-auto relative flex w-full max-w-md flex-col gap-2 rounded-xl border p-3 pr-9">
        <button
          type="button"
          aria-label="Hide"
          onClick={onHide}
          className="hover:bg-bg-2 absolute top-2 right-2 grid size-6 place-items-center rounded-control text-text-muted"
        >
          <X className="size-3.5" strokeWidth={1.5} />
        </button>
        <p className="text-sm font-medium text-text-primary">
          This {pageNoun(pageUrl)} isn't shared with {account ?? 'your account'}
        </p>
        <p className="text-xs text-text-muted">Comments on it are still in the chat.</p>
        <div className="flex flex-wrap gap-1.5">
          <Button size="xs" onClick={() => void signInFlow.start(site, pageUrl, { switching: true })}>
            Switch account
          </Button>
          <Button size="xs" variant="outline" onClick={() => void rpc.rig.pages.openInBrowser({ url: pageUrl })}>
            Open in {browser}
          </Button>
        </div>
      </div>
    </div>
  );
}
