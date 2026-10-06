import type { LucideIcon } from 'lucide-react';
import { createContext, useContext, type ReactNode } from 'react';
import { cn } from '@renderer/lib/utils';

/**
 * The pieces every Settings page is built from (board 23): a row is a label,
 * one sentence under it, and its control on the right; rows sit in a
 * `SettingsRows` group, hairlines between them. A search result highlights
 * its row for a moment through `SettingsHighlightContext`.
 */

/** The `data-settings-row` id search just jumped to, or null. */
export const SettingsHighlightContext = createContext<string | null>(null);

export function SettingsRows({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('divide-border-hairline flex flex-col divide-y', className)}>{children}</div>;
}

export function SettingsRow({
  id,
  label,
  description,
  control,
  htmlFor,
  leading,
  detail,
  disabled = false,
  descriptionTestId,
}: {
  /** The row's search id (`SETTINGS_ROWS`); rendered as `data-settings-row`. */
  id?: string;
  label: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  /** The control's element id, so clicking the label works the control. */
  htmlFor?: string;
  /** Before the label, e.g. an avatar or an agent's icon. */
  leading?: ReactNode;
  /** Under the description: a path, a status line, a warning. */
  detail?: ReactNode;
  disabled?: boolean;
  descriptionTestId?: string;
}) {
  const highlighted = useContext(SettingsHighlightContext);
  const isHighlighted = id !== undefined && highlighted === id;
  const labelClass = 'text-text-primary text-[14px] leading-snug font-medium';
  return (
    <div
      data-settings-row={id}
      data-highlighted={isHighlighted || undefined}
      className={cn(
        // Rounded only while highlighted: the divider is this row's top border,
        // and rounded corners would bend it up at both ends.
        '-mx-3 flex items-center gap-4 px-3 py-3.5 transition-colors duration-500',
        isHighlighted && 'bg-accent-subtle rounded-control duration-150',
        disabled && 'opacity-50'
      )}
    >
      {leading}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {htmlFor ? (
          <label htmlFor={htmlFor} className={labelClass}>
            {label}
          </label>
        ) : (
          <p className={labelClass}>{label}</p>
        )}
        {description && (
          <p className="text-text-muted text-[12.5px] leading-normal" data-testid={descriptionTestId}>
            {description}
          </p>
        )}
        {detail}
      </div>
      {control && <div className="flex shrink-0 items-center gap-1.5">{control}</div>}
    </div>
  );
}

/** A row-sized block for content that isn't one label and control (the agent list, browser sign-ins); highlights like a row. */
export function SettingsBlock({ id, children }: { id: string; children: ReactNode }) {
  const highlighted = useContext(SettingsHighlightContext) === id;
  return (
    <div
      data-settings-row={id}
      data-highlighted={highlighted || undefined}
      className={cn(
        '-mx-3 px-3 py-2 transition-colors duration-500',
        highlighted && 'bg-accent-subtle rounded-control duration-150'
      )}
    >
      {children}
    </div>
  );
}

/** The app's on/off switch (same look Settings has always used). */
export function SettingsSwitch({
  id,
  label,
  checked,
  disabled = false,
  onToggle,
}: {
  id: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        'relative h-4 w-7 shrink-0 rounded-full transition-colors disabled:pointer-events-none',
        checked ? 'bg-border-strong' : 'bg-bg-2 border-border-hairline border'
      )}
    >
      <span
        className={cn(
          'bg-bg-1 absolute top-0.5 left-0.5 size-3 rounded-full transition-transform',
          checked && 'translate-x-3'
        )}
      />
    </button>
  );
}

export type SegmentOption<T extends string> = { id: T; label: string; icon?: LucideIcon };

/** A small radio group: one pick among a few, e.g. System / Light / Dark. */
export function SettingsSegmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  /** The group's accessible name. */
  label: string;
  value: T;
  options: readonly SegmentOption<T>[];
  onChange: (next: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="bg-bg-2 flex gap-0.5 rounded-control p-0.5">
      {options.map(({ id, label: optionLabel, icon: Icon }) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          onClick={() => onChange(id)}
          className={cn(
            'flex h-7 items-center gap-1.5 rounded-[5px] px-3 text-xs transition-colors',
            value === id
              ? 'bg-bg-1 text-text-primary shadow-soft'
              : 'text-text-muted hover:text-text-primary'
          )}
        >
          {Icon && <Icon className="size-3.5" strokeWidth={1.5} />}
          {optionLabel}
        </button>
      ))}
    </div>
  );
}
