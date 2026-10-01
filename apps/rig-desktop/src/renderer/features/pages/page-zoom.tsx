import { Minus, Plus, RotateCcw } from 'lucide-react';
import { useCallback, useState } from 'react';
import { cn } from '@renderer/lib/utils';
import { canZoomIn, canZoomOut, formatBrowserZoomPercent, nextBrowserZoomFactor, normalizeBrowserZoomFactor, previousBrowserZoomFactor } from '@shared/browser';
import { effectivePageZoom, type PageZoomKey } from '@shared/pages/page-zoom';

/**
 * The page toolbar's zoom (− 80% + ↺) and what it remembers: a zoom you
 * chose, per site, in this computer's browser storage. No choice is the fit
 * (`fitPageZoom`), which follows the panel's width.
 */

const STORAGE_KEY = 'rig-page-zoom';

function readAll(): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export function readChosenZoom(site: string | null): number | null {
  if (!site) return null;
  const value = readAll()[site];
  return typeof value === 'number' && Number.isFinite(value) ? normalizeBrowserZoomFactor(value) : null;
}

export function writeChosenZoom(site: string | null, factor: number | null): void {
  if (!site) return;
  try {
    const all = readAll();
    if (factor === null) delete all[site];
    else all[site] = factor;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage unavailable: the zoom holds for this page only.
  }
}

/** Your choice after a zoom key: a step from what shows now, or back to the fit (null). */
export function chosenAfter(key: PageZoomKey, shown: number): number | null {
  if (key === 'reset') return null;
  return key === 'in' ? nextBrowserZoomFactor(shown) : previousBrowserZoomFactor(shown);
}

export function usePageZoom(site: string | null, panelWidth: number) {
  const [chosen, setChosen] = useState<number | null>(() => readChosenZoom(site));
  const factor = effectivePageZoom(chosen, panelWidth);
  const press = useCallback(
    (key: PageZoomKey) => {
      const next = chosenAfter(key, factor);
      setChosen(next);
      writeChosenZoom(site, next);
    },
    [factor, site]
  );
  return { factor, fitted: chosen === null, press };
}

const buttonClass =
  'hover:bg-bg-2 hover:text-text-primary flex h-7 items-center justify-center rounded-control text-text-secondary transition-colors disabled:pointer-events-none disabled:opacity-40';

export function PageZoomControl({
  factor,
  fitted,
  onPress,
}: {
  factor: number;
  /** No zoom chosen for the site: the page fits the panel. */
  fitted: boolean;
  onPress: (key: PageZoomKey) => void;
}) {
  const percent = formatBrowserZoomPercent(factor);
  return (
    <span className="flex items-center" role="group" aria-label="Page zoom" data-testid="page-zoom">
      <button
        type="button"
        onClick={() => onPress('out')}
        disabled={!canZoomOut(factor)}
        className={cn(buttonClass, 'w-7')}
        aria-label="Zoom out"
        title="Zoom out (⌘−)"
        data-testid="page-zoom-out"
      >
        <Minus className="size-3.5" strokeWidth={1.5} />
      </button>
      <span
        className="min-w-10 text-center text-xs text-text-secondary tabular-nums"
        title={fitted ? 'Fitted to the panel' : undefined}
        data-testid="page-zoom-level"
        data-fitted={fitted ? 'true' : undefined}
      >
        {percent}
      </span>
      <button
        type="button"
        onClick={() => onPress('in')}
        disabled={!canZoomIn(factor)}
        className={cn(buttonClass, 'w-7')}
        aria-label="Zoom in"
        title="Zoom in (⌘+)"
        data-testid="page-zoom-in"
      >
        <Plus className="size-3.5" strokeWidth={1.5} />
      </button>
      <button
        type="button"
        onClick={() => onPress('reset')}
        disabled={fitted}
        className={cn(buttonClass, 'w-7')}
        aria-label="Reset zoom"
        title="Reset zoom: fit to the panel (⌘0)"
        data-testid="page-zoom-reset"
      >
        <RotateCcw className="size-3.5" strokeWidth={1.5} />
      </button>
    </span>
  );
}
