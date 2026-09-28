import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe } from 'lucide-react';
import { useState } from 'react';
import { BrandLogo } from '@renderer/features/spaces/logos';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';

/**
 * Signing pages in (claude.ai, Google) with the person's Chrome session: the
 * Settings › Sign-ins rows and a page's first-open screen share this.
 * Design: canvas board 15.
 */

export type SignInSite = 'claude' | 'google';

export const SIGN_IN_SITES: { site: SignInSite; name: string }[] = [
  { site: 'claude', name: 'claude.ai' },
  { site: 'google', name: 'Google' },
];

/** Sign-ins are keyed by registrable domain now (board 18); this screen still offers these two until the chip replaces it. */
const SITE_ID: Record<SignInSite, string> = { claude: 'claude.ai', google: 'google.com' };

const STATUS_KEY = ['rig', 'pages', 'sign-in-status'];

export function useSignInStatus() {
  return useQuery({
    queryKey: STATUS_KEY,
    queryFn: async (): Promise<Record<SignInSite, boolean>> => {
      const { sites } = await rpc.rig.pages.signIns();
      const on = (site: SignInSite) => sites.some((s) => s.site === SITE_ID[site]);
      return { claude: on('claude'), google: on('google') };
    },
  });
}

const FAILED: Record<string, string> = {
  no_browser: "Chrome isn't installed on this Mac.",
  folder_access_denied: 'macOS didn’t let rig read Chrome’s data. Turn it on in System Settings › Privacy & Security › Files & Folders.',
  rejected_by_site: 'The site didn’t accept your Chrome sign-in in rig. Sign in here instead.',
  cancelled: 'Stopped.',
  not_signed_in: "You're not signed in to it in Chrome. Sign in there first, then try again.",
  keychain_denied: 'macOS didn’t allow it. Try again and choose Allow.',
  failed: 'Something went wrong reading your Chrome sign-in.',
};

/** Runs the import (macOS asks first) and says how it went. True when signed in. */
export function useChromeSignIn(): { signIn: (site: SignInSite) => Promise<boolean>; busy: SignInSite | null } {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<SignInSite | null>(null);
  const signIn = async (site: SignInSite) => {
    setBusy(site);
    try {
      // Until the sheet's profile picker: the most recently used profile signed in to the site.
      const options = await rpc.rig.pages.signInOptions({ site: SITE_ID[site] });
      const profile = options.ok ? options.profiles[0] : undefined;
      const result = profile
        ? await rpc.rig.pages.signIn({ site: SITE_ID[site], browser: profile.browser, profile: profile.dir })
        : { ok: false as const, reason: options.ok ? 'not_signed_in' : options.reason };
      await queryClient.invalidateQueries({ queryKey: STATUS_KEY });
      if (!result.ok) toast({ title: 'Couldn’t use your Chrome sign-in', description: FAILED[result.reason] });
      return result.ok;
    } finally {
      setBusy(null);
    }
  };
  return { signIn, busy };
}

function SiteMark({ site }: { site: SignInSite }) {
  return site === 'claude' ? <BrandLogo id="claude" size={14} /> : <Globe className="size-3.5 text-text-muted" strokeWidth={1.5} />;
}

/** Settings › Sign-ins. */
export function SignInRows() {
  const queryClient = useQueryClient();
  const status = useSignInStatus();
  const { signIn, busy } = useChromeSignIn();
  return (
    <div className="flex flex-col gap-2" data-testid="settings-sign-ins">
      {SIGN_IN_SITES.map(({ site, name }) => {
        const on = status.data?.[site] ?? false;
        return (
          <div key={site} className="flex items-center gap-2 text-xs">
            <SiteMark site={site} />
            <span className="font-medium text-text-primary">{name}</span>
            <span className="text-text-muted">{on ? 'signed in' : 'not connected'}</span>
            <span className="ml-auto">
              {on ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void rpc.rig.pages.signOut({ site: SITE_ID[site] }).then(() => queryClient.invalidateQueries({ queryKey: STATUS_KEY }))
                  }
                >
                  Remove
                </Button>
              ) : (
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void signIn(site)}>
                  Use Chrome sign-in
                </Button>
              )}
            </span>
          </div>
        );
      })}
      <p className="text-xs text-text-muted">Pages beside the chat open as you. Agents see them only as you, while a turn runs.</p>
    </div>
  );
}

/** A page's first open, when rig isn't signed in to its site yet. */
export function FirstOpen({ site, onDone, onOpenInBrowser }: { site: SignInSite; onDone: () => void; onOpenInBrowser: () => void }) {
  const { signIn, busy } = useChromeSignIn();
  const name = SIGN_IN_SITES.find((s) => s.site === site)!.name;
  return (
    <div className="bg-bg-1 absolute inset-0 z-20 grid place-items-center" data-testid="page-first-open">
      <div className="flex max-w-sm flex-col items-start gap-3 p-6">
        <SiteMark site={site} />
        <p className="text-sm font-medium text-text-primary">Open {name} as you</p>
        <p className="text-xs text-text-secondary">Rig uses your Chrome sign-in for {name} only.</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy !== null} onClick={() => void signIn(site).then((ok) => ok && onDone())}>
            Use Chrome sign-in
          </Button>
          <Button size="sm" variant="ghost" onClick={onOpenInBrowser}>
            Open in browser
          </Button>
        </div>
        <button type="button" onClick={onDone} className="text-xs text-text-muted hover:text-text-primary">
          Sign in here instead
        </button>
      </div>
    </div>
  );
}
