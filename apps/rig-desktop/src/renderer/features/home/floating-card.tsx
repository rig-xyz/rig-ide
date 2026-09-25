import { ChevronDown } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { cn } from '@renderer/lib/utils';

/**
 * Home restructure, "spaces first" (design doc "9a"): the floating glass
 * card look Spaces/Solo rigs share with the Room's own pinned panel
 * (`features/workspace/pinned-card.tsx`) — same surface tokens
 * (`border-border-hairline bg-bg-1 shadow-float rounded-card`), used here
 * as a normal in-flow block rather than an absolutely-positioned overlay.
 *
 * "Collapsible and hideable" (design doc): one persisted collapse toggle —
 * a collapsed card is header-only, which covers "out of the way" without a
 * second, harder-to-recover "hide entirely with no way back" control the
 * approved mock never actually shows an affordance for.
 */
function readCollapsed(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

function writeCollapsed(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // localStorage unavailable — just won't persist.
  }
}

export function FloatingCard({
  storageKey,
  title,
  count,
  headerAction,
  children,
}: {
  /** localStorage key for this card's own collapse state — distinct per card. */
  storageKey: string;
  title: string;
  count?: number;
  /** Rendered beside the collapse chevron, only while expanded (e.g. Rigs' "+ New"). */
  headerAction?: ReactNode;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(() => readCollapsed(storageKey));
  const toggle = () => {
    setCollapsed((current) => {
      const next = !current;
      writeCollapsed(storageKey, next);
      return next;
    });
  };

  return (
    <div className="border-border-hairline bg-bg-1 shadow-float flex flex-col gap-2 rounded-card border p-3">
      <div className="flex h-6 items-center gap-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <span className="text-text-primary truncate text-sm font-medium">{title}</span>
          {count !== undefined && <span className="text-text-muted text-xs">{count}</span>}
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {!collapsed && headerAction}
          <button
            type="button"
            onClick={toggle}
            aria-label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
            className="text-text-muted hover:text-text-primary rounded-control flex items-center justify-center p-1 transition-colors"
          >
            <ChevronDown
              className={cn('size-3.5 transition-transform', !collapsed && 'rotate-180')}
              strokeWidth={1.5}
            />
          </button>
        </div>
      </div>
      {!collapsed && children}
    </div>
  );
}
