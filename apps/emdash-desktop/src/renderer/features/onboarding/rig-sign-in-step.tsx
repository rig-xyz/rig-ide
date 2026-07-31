import { useQuery } from '@tanstack/react-query';
import { AlertCircle, Check, CheckCircle, Copy, LogIn } from 'lucide-react';
import { useState } from 'react';
import { useRigSignIn } from '@renderer/features/rig-account/use-rig-sign-in';
import { rpc } from '@renderer/lib/ipc';
import { confirmOpenExternalLink } from '@renderer/lib/open-external-link';
import { Button } from '@renderer/lib/ui/button';
import { PRODUCT_NAME } from '@shared/app-identity';

/**
 * The sign-in link, for when the browser did not come up on its own. `rig login`
 * is listening on its own loopback port for exactly this URL, so pasting it into
 * any browser completes the same flow.
 */
function ManualLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <p className="text-xs text-foreground-muted">
        Didn&apos;t your browser open? Open this link yourself:
      </p>
      <code className="truncate font-mono text-xs text-foreground-muted">{url}</code>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={copy}>
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy link'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => confirmOpenExternalLink(url)}>
          Open again
        </Button>
      </div>
    </div>
  );
}

/**
 * First-run step 2. Signing in mints the relay PAT that comments and sync ride
 * on; without it both are silently dead.
 *
 * Skippable on purpose — the app has to stay usable solo, and this can be done
 * later by running `rig login`.
 */
export function RigSignInStep({ onComplete }: { onComplete: () => void }) {
  const { data: status, isLoading } = useQuery({
    queryKey: ['rig', 'auth', 'status'],
    queryFn: () => rpc.rig.auth.status(),
  });
  const { phase, url, error, signIn, cancel } = useRigSignIn(onComplete);

  const handleSignIn = () => void signIn();

  const handleSkip = () => {
    cancel();
    onComplete();
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-foreground-muted">
        Loading...
      </div>
    );
  }

  if (status?.signedIn) {
    return (
      <div className="flex max-w-sm flex-col space-y-8">
        <div className="flex flex-col items-center justify-center gap-6">
          <CheckCircle className="h-10 w-10" absoluteStrokeWidth strokeWidth={1.5} />
          <div className="flex flex-col items-center justify-center gap-2">
            <h1 className="text-center text-xl">Signed in to Rig</h1>
            <p className="text-md text-center text-foreground-muted">
              Comments and sync are ready to go.
            </p>
          </div>
        </div>
        <Button size={'lg'} onClick={onComplete}>
          Continue
        </Button>
      </div>
    );
  }

  const isBusy = phase !== 'idle';

  return (
    <div className="flex max-w-sm flex-col space-y-8">
      <div className="flex flex-col items-center justify-center gap-6">
        <LogIn className="h-10 w-10" absoluteStrokeWidth strokeWidth={1.5} />
        <div className="flex flex-col items-center justify-center gap-2">
          <h1 className="text-center text-xl">Sign in to Rig</h1>
          <p className="text-md text-center text-foreground-muted">
            Your Rig account is what turns on comments, sync, and sharing work with teammates.
            {` ${PRODUCT_NAME} `}
            works without it — you can sign in later.
          </p>
        </div>
      </div>
      <div className="flex w-full flex-col gap-2">
        <Button size={'lg'} onClick={handleSignIn} disabled={isBusy}>
          <LogIn className="h-4 w-4" />
          {phase === 'idle' ? 'Sign in to Rig' : 'Waiting for sign-in…'}
        </Button>
        {phase === 'waiting' && url && <ManualLink url={url} />}
        {error && (
          <div className="bg-destructive/10 text-destructive flex items-start gap-1.5 rounded-md px-2.5 py-2 text-xs">
            <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        <Button size={'lg'} variant="outline" onClick={handleSkip}>
          Skip for now
        </Button>
      </div>
    </div>
  );
}
