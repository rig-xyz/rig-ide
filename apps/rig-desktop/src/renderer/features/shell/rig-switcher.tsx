import { useQuery } from '@tanstack/react-query';
import { motion, useReducedMotion } from 'framer-motion';
import { Check, ChevronDown, FolderOpen } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { rpc } from '@renderer/lib/ipc';
import { Popover } from '@renderer/lib/ui/popover';
import { RigMark } from '@renderer/lib/ui/rig-mark';
import { InlineRigNameInput } from './inline-rig-name';

/**
 * The topbar mini-breadcrumb's rig-name segment, as a switcher trigger
 * (dogfooding round: the founder either went Home first or wanted to
 * switch directly — reading the file browser's native-picker "Open…" as
 * the only way to change rigs was wrong). Trigger reads exactly like the
 * old static breadcrumb segment (folder icon + name) with a quiet trailing
 * chevron; the portal menu lists recent/local rigs — same `recentRigs` read
 * Home's rigs rail uses (`home.tsx`'s `localRigsQuery`, same query key so
 * the cache is already warm coming from Home) — with the current rig
 * checked, and "Open folder…" as the native-picker escape hatch in the
 * last row. Portal/dismissal/positioning come from the shared `Popover`
 * primitive (`@renderer/lib/ui/popover`).
 *
 * Onboarding flow round (docs/onboarding-flow-spec.md §2/5): `autoEdit`
 * lands a just-created rig straight into inline rename here — the trigger
 * button is replaced by `InlineRigNameInput` in place, with the rig mark
 * settling in beside it (a quiet fade, not a decorative flourish;
 * `prefers-reduced-motion` skips it entirely). The caller keys this
 * component by `bindingId` so switching to a genuinely different rig gets
 * a fresh mount — `autoEdit` only ever fires once per rig.
 */
export function RigSwitcher({
  bindingId,
  path,
  name,
  onOpenPath,
  onOpenFolder,
  autoEdit = false,
  onAutoEditHandled,
}: {
  /** The currently-open rig's binding id — checks the matching row. */
  bindingId: string;
  /** The rig's workspace root — needed alongside `bindingId` for the rename rpc. */
  path: string;
  name: string;
  onOpenPath: (path: string) => void;
  onOpenFolder: () => void;
  /** True immediately after this rig was just created — enters inline rename once, auto-focused with the name selected. */
  autoEdit?: boolean;
  /** Called once `autoEdit`'s edit mode has been entered, so the caller can drop its flag. */
  onAutoEditHandled?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(name);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const consumedAutoEdit = useRef(false);
  const prefersReducedMotion = useReducedMotion();

  useEffect(() => setDisplayName(name), [name]);

  useEffect(() => {
    if (!autoEdit || consumedAutoEdit.current) return;
    consumedAutoEdit.current = true;
    setEditing(true);
    onAutoEditHandled?.();
  }, [autoEdit, onAutoEditHandled]);

  const recentQuery = useQuery({
    queryKey: ['rig', 'recent', 'list'],
    queryFn: () => rpc.rig.recent.recentRigs(50),
    enabled: open,
    staleTime: 5_000,
  });
  const rows = recentQuery.data ?? [];

  if (editing) {
    const row = (
      <>
        <RigMark size={11} className="text-text-muted shrink-0" />
        <InlineRigNameInput
          bindingId={bindingId}
          path={path}
          name={displayName}
          onCommitted={(newName) => {
            setDisplayName(newName);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
          className="min-w-0 max-w-64 flex-1 rounded-control bg-bg-2 px-1 py-0.5 text-text-primary outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        />
      </>
    );
    // Motion round (docs/onboarding-flow-spec.md §5): the ONLY moment this
    // settles in with a reveal is right after creation (`autoEdit`, not
    // every later rename) — a plain fade, no transform, and skipped
    // entirely under reduced motion.
    if (!autoEdit || prefersReducedMotion) {
      return <div className="flex min-w-0 shrink items-center gap-1 px-1 py-0.5">{row}</div>;
    }
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
        className="flex min-w-0 shrink items-center gap-1 px-1 py-0.5"
      >
        {row}
      </motion.div>
    );
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="text-text-muted hover:bg-bg-2 hover:text-text-primary rounded-control flex min-w-0 shrink items-center gap-1 px-1 py-0.5 transition-colors [-webkit-app-region:no-drag]"
      >
        <FolderOpen className="size-3 shrink-0" strokeWidth={1.5} />
        <span className="max-w-64 truncate">{displayName}</span>
        <ChevronDown className="size-3 shrink-0" strokeWidth={1.5} />
      </button>
      <Popover
        anchor={triggerRef}
        open={open}
        onClose={() => setOpen(false)}
        role="menu"
        gap={4}
        estimatedWidth={260}
        minWidth={260}
      >
        {rows.map((row) => (
          <button
            key={row.bindingId}
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => {
              setOpen(false);
              if (row.bindingId !== bindingId) onOpenPath(row.path);
            }}
            className="hover:bg-bg-2 flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
          >
            <span className="flex size-3.5 shrink-0 items-center justify-center">
              {row.bindingId === bindingId && <Check className="size-3" strokeWidth={1.5} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="text-text-primary block truncate text-sm">
                {row.name ?? row.path.split('/').pop()}
              </span>
            </span>
          </button>
        ))}
        <div className="border-border-hairline mt-1 border-t pt-1">
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => {
              setOpen(false);
              onOpenFolder();
            }}
            className="hover:bg-bg-2 text-text-secondary flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm"
          >
            <FolderOpen className="size-3.5 shrink-0" strokeWidth={1.5} />
            Open folder…
          </button>
        </div>
      </Popover>
    </>
  );
}
