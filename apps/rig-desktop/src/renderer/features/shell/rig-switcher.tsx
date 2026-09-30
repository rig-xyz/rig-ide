import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion, useReducedMotion } from 'framer-motion';
import { Check, ChevronDown, FolderOpen, Hash, Home as HomeIcon, Loader2, Pencil, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { generateSpaceName } from '@renderer/features/home/space-create';
import { startSpaceSetup } from '@renderer/features/spaces/space-setup-store';
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
 *
 * Polish round 2, lane F: inside a space, the menu is space-scoped now —
 * "your spaces" only (never a plain rig mixed in), then "New space" (the
 * same one-click auto-named create Home's own primary CTA drives — see
 * `space-create.ts`'s `generateSpaceName`) and "All spaces" (`onGoHome`,
 * back to Home). "Open folder…" is dropped for a space — a space has no
 * "browse to a folder I already have" case the way a plain rig does. A
 * plain rig keeps today's unfiltered menu and "Open folder…" unchanged.
 */
export function RigSwitcher({
  bindingId,
  path,
  name,
  onOpenPath,
  onOpenFolder,
  onGoHome,
  autoEdit = false,
  onAutoEditHandled,
  isSpace = false,
}: {
  /** The currently-open rig's binding id — checks the matching row. */
  bindingId: string;
  /** The rig's workspace root — needed alongside `bindingId` for the rename rpc. */
  path: string;
  name: string;
  onOpenPath: (path: string, opts?: { kind?: 'space' }) => void;
  onOpenFolder: () => void;
  /** "All spaces" (space menu only) — back to Home, same house-button target the breadcrumb's own icon uses. */
  onGoHome: () => void;
  /** True immediately after this rig was just created — enters inline rename once, auto-focused with the name selected. */
  autoEdit?: boolean;
  /** Called once `autoEdit`'s edit mode has been entered, so the caller can drop its flag. */
  onAutoEditHandled?: () => void;
  /** Room chrome round: a space's own identity is its `#name`, never a
   * folder — the trigger wears the `Hash` glyph instead of `FolderOpen`. */
  isSpace?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(name);
  const [creatingSpace, setCreatingSpace] = useState(false);
  const [createSpaceError, setCreateSpaceError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const consumedAutoEdit = useRef(false);
  const prefersReducedMotion = useReducedMotion();
  const queryClient = useQueryClient();

  useEffect(() => setDisplayName(name), [name]);

  useEffect(() => {
    if (!autoEdit || consumedAutoEdit.current) return;
    consumedAutoEdit.current = true;
    setEditing(true);
    onAutoEditHandled?.();
  }, [autoEdit, onAutoEditHandled]);

  // Feedback round, Part A: signed out, no account owns anything shown here
  // — the switcher's OWN list of other rigs to jump to must be empty, same
  // as Home's rail (`home.tsx`'s new signed-out gate). The currently-open
  // rig's own trigger (name/icon below) is untouched — that's just context,
  // not a rig list — and "Open folder…" stays reachable regardless, since
  // browsing to a local folder needs no account.
  const authQuery = useQuery({
    queryKey: ['rig', 'auth', 'status'],
    queryFn: () => rpc.rig.auth.status(),
  });
  const signedIn = authQuery.data?.signedIn ?? false;

  const recentQuery = useQuery({
    queryKey: ['rig', 'recent', 'list'],
    queryFn: () => rpc.rig.recent.recentRigs(50),
    enabled: open && signedIn,
    staleTime: 5_000,
  });
  const rows = signedIn ? (recentQuery.data ?? []) : [];

  // Space menu round: `recentRigs` carries no space/rig distinction of its
  // own (it's a plain `rig_rigs` row) — the same cross-reference
  // `home-sections.ts`'s `buildHomeRigRows` uses against
  // `rpc.rig.account.workspaces()`'s own `kind` field.
  const workspacesQuery = useQuery({
    queryKey: ['rig', 'account', 'workspaces'],
    queryFn: () => rpc.rig.account.workspaces(),
    enabled: open && signedIn && isSpace,
    staleTime: 5_000,
  });
  const spaceBindingIds = new Set(
    workspacesQuery.data?.success
      ? workspacesQuery.data.data.filter((b) => b.kind === 'space').map((b) => b.id)
      : []
  );
  const displayRows = isSpace ? rows.filter((row) => spaceBindingIds.has(row.bindingId)) : rows;

  const createSpaceOneClick = async () => {
    if (creatingSpace) return;
    setCreatingSpace(true);
    setCreateSpaceError(null);
    const existingNames = new Set(
      displayRows.map((row) => row.name).filter((n): n is string => !!n)
    );
    // Opens the new space's Room at once; it's set up in the background.
    const failure = await startSpaceSetup(generateSpaceName(existingNames));
    setCreatingSpace(false);
    if (failure) {
      setCreateSpaceError(failure);
      return;
    }
    setOpen(false);
  };

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
            // Home's lists show the name too (same refresh the Rename… dialog triggers there).
            void queryClient.invalidateQueries({ queryKey: ['rig', 'recent'] });
            void queryClient.invalidateQueries({ queryKey: ['rig', 'account'] });
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
        // Double-click the name to rename it in place, as in a file list.
        onDoubleClick={() => {
          setOpen(false);
          setEditing(true);
        }}
        title="Double-click to rename"
        aria-haspopup="menu"
        aria-expanded={open}
        className="text-text-muted hover:bg-bg-2 hover:text-text-primary rounded-control flex min-w-0 shrink items-center gap-1 px-1 py-0.5 transition-colors [-webkit-app-region:no-drag]"
      >
        {isSpace ? (
          <Hash className="size-3 shrink-0" strokeWidth={1.5} />
        ) : (
          <FolderOpen className="size-3 shrink-0" strokeWidth={1.5} />
        )}
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
        {displayRows.map((row) => (
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
                {isSpace ? `#${row.name ?? row.path.split('/').pop()}` : (row.name ?? row.path.split('/').pop())}
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
              setEditing(true);
            }}
            className="hover:bg-bg-2 text-text-secondary flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm"
          >
            <Pencil className="size-3.5 shrink-0" strokeWidth={1.5} />
            Rename…
          </button>
          {isSpace ? (
            <>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => void createSpaceOneClick()}
                disabled={creatingSpace}
                className="hover:bg-bg-2 text-text-secondary flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm disabled:pointer-events-none disabled:opacity-60"
              >
                {creatingSpace ? (
                  <Loader2 className="size-3.5 shrink-0 animate-spin" strokeWidth={1.5} />
                ) : (
                  <Plus className="size-3.5 shrink-0" strokeWidth={1.5} />
                )}
                {creatingSpace ? 'Starting…' : 'New space'}
              </button>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  setOpen(false);
                  onGoHome();
                }}
                className="hover:bg-bg-2 text-text-secondary flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm"
              >
                <HomeIcon className="size-3.5 shrink-0" strokeWidth={1.5} />
                All spaces
              </button>
              {createSpaceError && <p className="text-danger px-2.5 pt-1 pb-0.5 text-xs">{createSpaceError}</p>}
            </>
          ) : (
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
          )}
        </div>
      </Popover>
    </>
  );
}
