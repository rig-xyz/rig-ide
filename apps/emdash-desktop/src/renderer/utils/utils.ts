import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * `text-tiny` (11px) and `text-micro` (10px) are this app's own additions to the
 * type scale (see `--text-tiny` / `--text-micro` in index.css). tailwind-merge
 * only knows the stock sizes, and for an unrecognised `text-*` it falls back to
 * treating the class as a text *colour* — so `cn('text-tiny', 'text-foreground')`
 * looked like two colours, kept the last, and silently dropped the size. The
 * element then inherited its parent's size, which is a hard bug to see: the
 * class is right there in the source and in the DOM's className, just merged
 * away. Registering them as font sizes makes the merge behave.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['tiny', 'micro'] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
