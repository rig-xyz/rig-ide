import { useQuery } from '@tanstack/react-query';
import { Check, Copy } from 'lucide-react';
import { confirmOpenExternalLink } from '@renderer/lib/open-external-link';
import { useClipboard } from '@renderer/lib/hooks/use-clipboard';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { useRigSignIn } from '@renderer/features/rig-account/use-rig-sign-in';

/**
 * Step 2 — sign in to Rig, skippable. Ported from
 * `apps/emdash-desktop`'s `RigSignInStep` copy/pattern (read-only
 * reference) onto this app's own already-working `useRigSignIn` — this
 * step never existed independently in emdash, `useRigSignIn` was already
 * written to match it.
 */
export function SignInStep({ onComplete }: { onComplete: () => void }) {
  const statusQuery = useQuery({
    queryKey: ['rig', 'auth', 'status'],
    queryFn: () => rpc.rig.auth.status(),
  });
  const { phase, url, error, signIn, cancel } = useRigSignIn(onComplete);

  // F fix: a quiet placeholder instead of a blank body while the sign-in
  // status is still resolving.
  if (statusQuery.isLoading) {
    return (
      <div className="flex w-full flex-col items-center gap-6 text-center">
        <p className="text-text-muted text-sm">Checking sign-in status…</p>
      </div>
    );
  }

  if (statusQuery.data?.signedIn) {
    return (
      <div className="flex w-full flex-col items-center gap-6 text-center">
        <div className="flex flex-col gap-1.5">
          <h1 className="font-display text-text-primary text-xl">Signed in to Rig</h1>
          <p className="text-text-muted text-sm">Comments and sync are ready to go.</p>
        </div>
        <Button className="w-full" onClick={onComplete}>
          Continue
        </Button>
      </div>
    );
  }

  const handleSkip = () => {
    cancel();
    onComplete();
  };

  return (
    <div className="flex w-full flex-col items-center gap-6 text-center">
      <div className="flex flex-col gap-1.5">
        <h1 className="font-display text-text-primary text-xl">Sign in to Rig</h1>
        <p className="text-text-muted max-w-xs text-sm">
          Your Rig account is what turns on comments, sync, and sharing work with teammates. Rig
          works without it, and you can sign in later.
        </p>
      </div>

      {error && <p className="text-danger text-xs">{error}</p>}

      <Button className="w-full" onClick={() => void signIn()} disabled={phase !== 'idle'}>
        {phase === 'idle' ? 'Sign in to Rig' : 'Waiting for sign-in…'}
      </Button>

      {phase === 'waiting' && url && <ManualLink url={url} />}

      <Button variant="outline" className="w-full" onClick={handleSkip}>
        Skip for now
      </Button>
    </div>
  );
}

function ManualLink({ url }: { url: string }) {
  // F fix: reuse `useClipboard` instead of duplicating its copy/reset logic.
  const clipboard = useClipboard();
  return (
    <div className="border-border-hairline flex w-full flex-col gap-2 rounded-control border p-3 text-left">
      <p className="text-text-muted text-xs">Didn&apos;t your browser open? Open this link yourself:</p>
      <code className="text-text-muted truncate font-mono text-xs">{url}</code>
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
