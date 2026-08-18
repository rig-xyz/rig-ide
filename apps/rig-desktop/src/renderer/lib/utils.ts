import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** `clsx` + `tailwind-merge`: compose conditional class lists, last conflicting utility wins. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
