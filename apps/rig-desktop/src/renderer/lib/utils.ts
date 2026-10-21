import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * The Home feed's named type steps (`tokens.css`). Without this, tailwind-merge
 * reads `text-meta` as a color and drops the real color class next to it.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: { 'font-size': [{ text: ['face', 'kicker', 'meta', 'ui', 'chat', 'title'] }] },
  },
});

/** `clsx` + `tailwind-merge`: compose conditional class lists, last conflicting utility wins. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
