import { FileText, Link, X } from 'lucide-react';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { cn } from '@renderer/lib/utils';
import type { ImportSourceInput, ImportSourceMode, ImportSourceState } from './import-source';

/**
 * The shared import entry (design round): TWO compact choice tiles —
 * "Paste a link" / "Choose a .docx" — with the active source visibly
 * selected (bg-2 fill + border shift; never a colored rail, Rule 2/3),
 * then that mode's own affordance beneath: the URL input, or the picker
 * button / clearable mono file chip. Purely controlled — both dialogs own
 * their state and busy-gating around it.
 */
export function ImportDocField({
  value,
  state,
  disabled,
  onChange,
}: {
  value: ImportSourceInput;
  state: ImportSourceState;
  disabled: boolean;
  onChange: (next: ImportSourceInput) => void;
}) {
  const chooseDocx = async () => {
    try {
      const picked = await rpc.app.openSelectDocumentFileDialog({
        title: 'Choose a .docx',
        message: 'Pick the document to import',
      });
      if (picked) onChange({ ...value, mode: 'docx', filePath: picked });
    } catch (error) {
      toast({
        title: "Couldn't open the file picker",
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        <SourceTile
          icon={<Link className="size-3.5 shrink-0" strokeWidth={1.5} />}
          label="Paste a link"
          active={value.mode === 'link'}
          disabled={disabled}
          onSelect={() => onChange({ ...value, mode: 'link' })}
        />
        <SourceTile
          icon={<FileText className="size-3.5 shrink-0" strokeWidth={1.5} />}
          label="Choose a .docx"
          active={value.mode === 'docx'}
          disabled={disabled}
          onSelect={() => onChange({ ...value, mode: 'docx' })}
        />
      </div>

      {value.mode === 'link' ? (
        <>
          <input
            type="url"
            value={value.url}
            onChange={(event) => onChange({ ...value, url: event.target.value })}
            disabled={disabled}
            placeholder="https://docs.google.com/document/…"
            // D2 fix: a bare `outline-none` here suppressed the global
            // `:focus-visible` ring too (Tailwind's utilities layer beats
            // `@layer base`, regardless of selector specificity) — silently
            // dropping keyboard focus visibility on this field. Re-added
            // via `focus-visible:` utilities, same convention buttons
            // already use elsewhere (e.g. `agents-step.tsx`'s userig.xyz link).
            className="border-border-hairline bg-bg-1 text-text-primary placeholder:text-text-muted focus-visible:outline-accent rounded-control border px-2 py-1.5 text-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2"
          />
          {state.urlError && <p className="text-danger text-xs">{state.urlError}</p>}
        </>
      ) : value.filePath ? (
        <div className="border-border-hairline bg-bg-2 flex items-center gap-2 rounded-control border px-2 py-1.5">
          <FileText className="text-text-muted size-3.5 shrink-0" strokeWidth={1.5} />
          <span className="text-text-secondary min-w-0 flex-1 truncate font-mono text-xs">
            {value.filePath}
          </span>
          <button
            type="button"
            onClick={() => onChange({ ...value, filePath: null })}
            aria-label="Clear the chosen file"
            disabled={disabled}
            className="text-text-muted hover:text-text-primary shrink-0"
          >
            <X className="size-3" strokeWidth={1.5} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => void chooseDocx()}
          disabled={disabled}
          className="border-border-hairline text-text-secondary hover:bg-bg-2 hover:text-text-primary rounded-control flex items-center gap-1.5 self-start border bg-transparent px-2 py-1 text-xs transition-colors"
        >
          <FileText className="size-3.5" strokeWidth={1.5} />
          Choose file…
        </button>
      )}
    </div>
  );
}

function SourceTile({
  icon,
  label,
  active,
  disabled,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      disabled={disabled}
      className={cn(
        'rounded-control flex items-center justify-center gap-1.5 border px-2 py-1.5 text-xs transition-colors',
        active
          ? 'border-border-strong bg-bg-2 text-text-primary'
          : 'border-border-hairline text-text-secondary hover:text-text-primary bg-transparent'
      )}
    >
      {icon}
      {label}
    </button>
  );
}

export type { ImportSourceMode };
