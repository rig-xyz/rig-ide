import {
  AlertCircle,
  ArrowRight,
  KeyRound,
  Loader2,
  type LucideIcon,
  Terminal,
} from 'lucide-react';
import { useState } from 'react';
import { useToast } from '@renderer/lib/hooks/use-toast';
import {
  useGitHubDeviceFlowAuth,
  useImportGitHubCliAccounts,
} from '@renderer/lib/hooks/useGithubAccounts';
import { type BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { cn } from '@renderer/utils/utils';
import { PRODUCT_NAME } from '@shared/app-identity';

type MethodError = {
  method: 'cli' | 'device_flow';
  message: string;
} | null;

export function GithubConnectModal({ onSuccess, onClose }: BaseModalProps<void>) {
  const { toast } = useToast();
  const deviceFlowMutation = useGitHubDeviceFlowAuth();
  const importCliAccountsMutation = useImportGitHubCliAccounts();
  const showDeviceFlow = useShowModal('githubDeviceFlowModal');
  const [cliLoading, setCliLoading] = useState(false);
  const [error, setError] = useState<MethodError>(null);

  const deviceFlowLoading = deviceFlowMutation.isPending;
  const anyLoading = cliLoading || deviceFlowLoading;

  const refreshCliAuth = async () => {
    setError(null);
    setCliLoading(true);
    try {
      const result = await importCliAccountsMutation.mutateAsync();
      if (!result.success) {
        setError({
          method: 'cli',
          message: result.error,
        });
        return;
      }

      if (result.importedAccountIds.length === 0) {
        setError({
          method: 'cli',
          message: 'No GitHub CLI session found. Run gh auth login first.',
        });
        return;
      }

      toast({
        title: 'GitHub CLI accounts imported',
        description:
          result.importedAccountIds.length === 1
            ? `1 account is available in ${PRODUCT_NAME}.`
            : `${result.importedAccountIds.length} accounts are available in ${PRODUCT_NAME}.`,
      });
      onSuccess();
    } finally {
      setCliLoading(false);
    }
  };

  const connectDeviceFlow = () => {
    setError(null);
    showDeviceFlow({});
    void deviceFlowMutation.mutateAsync();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Connect GitHub</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="gap-3">
        <ConnectMethodCard
          icon={Terminal}
          title="Import from GitHub CLI"
          description="Use accounts already authenticated with GitHub CLI"
          label="Import from GitHub CLI"
          loadingLabel="Checking GitHub CLI accounts"
          loading={cliLoading}
          disabled={anyLoading}
          onClick={() => void refreshCliAuth()}
          error={error?.method === 'cli' ? error.message : undefined}
        />

        <ConnectMethodCard
          icon={KeyRound}
          title="Use device flow"
          description="Connect GitHub on this device with a one-time code"
          label="Use device flow"
          loadingLabel="Opening device flow"
          loading={deviceFlowLoading}
          disabled={anyLoading}
          onClick={connectDeviceFlow}
          error={error?.method === 'device_flow' ? error.message : undefined}
        />
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={anyLoading}>
          Cancel
        </Button>
      </DialogFooter>
    </>
  );
}

function ConnectMethodCard({
  icon: Icon,
  title,
  description,
  label,
  loadingLabel,
  loading,
  disabled,
  onClick,
  error,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  label: string;
  loadingLabel: string;
  loading: boolean;
  disabled: boolean;
  onClick: () => void;
  error?: string;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={loading ? loadingLabel : label}
        className={cn(
          'group flex w-full items-center gap-3 p-3 text-left transition-colors',
          'hover:bg-background-2',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
          'disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent'
        )}
      >
        <Icon className="text-muted-foreground h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          <p className="text-muted-foreground mt-0.5 text-xs">{description}</p>
        </div>
        {loading ? (
          <Loader2 className="text-muted-foreground h-4 w-4 shrink-0 animate-spin" />
        ) : (
          <ArrowRight className="text-muted-foreground h-4 w-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
        )}
      </button>
      {error && <InlineError message={error} className="mx-3 mt-2 mb-3" />}
    </div>
  );
}

function InlineError({ message, className }: { message: string; className?: string }) {
  return (
    <div
      className={cn(
        'bg-destructive/10 text-destructive flex items-start gap-1.5 rounded-md px-2.5 py-2 text-xs',
        className
      )}
    >
      <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}
