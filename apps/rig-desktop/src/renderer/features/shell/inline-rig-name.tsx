import { useEffect, useRef, useState } from 'react';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';

/**
 * The topbar mini-breadcrumb's rig name, in place: an auto-focused,
 * auto-selected `<input>` that replaces `RigSwitcher`'s trigger button
 * while editing. Onboarding flow round (docs/onboarding-flow-spec.md §2) —
 * lands the just-created rig's name in edit mode so typing one is optional
 * and instant; also reusable for a later normal-rename entrance.
 *
 * Drives the same `rpc.rig.control.rename` `RenameRigDialog` uses (rewrites
 * `rig.toml`'s `[rig].name` in place and mirrors it into `rig_rigs`).
 * Enter/blur commits; Escape reverts to `name` with no rename call at all —
 * a fresh "Untitled rig" left untouched stays exactly that.
 */
export function InlineRigNameInput({
  bindingId,
  path,
  name,
  onCommitted,
  onCancel,
  className,
}: {
  bindingId: string;
  path: string;
  name: string;
  onCommitted: (name: string) => void;
  onCancel: () => void;
  className?: string;
}) {
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const settledRef = useRef(false);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const settle = async (commitIntent: boolean) => {
    if (settledRef.current) return;
    settledRef.current = true;
    const trimmed = value.trim();
    if (!commitIntent || !trimmed || trimmed === name) {
      onCancel();
      return;
    }
    setBusy(true);
    const result = await rpc.rig.control.rename({ bindingId, path, name: trimmed });
    setBusy(false);
    if (!result.success) {
      toast({
        title: "Couldn't rename the rig",
        description: result.error.message,
        variant: 'destructive',
      });
      onCancel();
      return;
    }
    onCommitted(result.data.name);
  };

  return (
    <input
      ref={inputRef}
      value={value}
      disabled={busy}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => void settle(true)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          void settle(true);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          void settle(false);
        }
      }}
      className={className}
    />
  );
}
