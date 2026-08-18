import type { ReactNode } from 'react';
import { toast as sonnerToast } from 'sonner';

/** Thin wrapper over `sonner` so call sites don't depend on the toast library directly. */

type ToastAction = {
  label: string;
  onClick: () => void;
};

type Toast = {
  title?: string;
  description?: string;
  variant?: 'default' | 'destructive';
  action?: ToastAction;
  icon?: ReactNode;
  /** Explicit `×` affordance — sonner's own default is swipe-to-dismiss only, which isn't a discoverable "dismiss" for a standing notification. Opt-in per call, not global, so every other toast in the app keeps its current look. */
  closeButton?: boolean;
  /** ms, or `Infinity` to never auto-dismiss — for a toast worth leaving up until the user acts (or explicitly closes it), not sonner's default ~4s. */
  duration?: number;
};

function toast({ title, description, variant, action, icon, closeButton, duration }: Toast) {
  const options = {
    description,
    icon,
    ...(action && { action: { label: action.label, onClick: action.onClick } }),
    ...(closeButton !== undefined && { closeButton }),
    ...(duration !== undefined && { duration }),
  };

  if (variant === 'destructive') {
    return sonnerToast.error(title, options);
  }
  return sonnerToast(title ?? '', options);
}

function useToast() {
  return { toast };
}

export { toast, useToast };
