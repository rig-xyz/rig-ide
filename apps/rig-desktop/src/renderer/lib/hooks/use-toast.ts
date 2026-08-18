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
};

function toast({ title, description, variant, action, icon }: Toast) {
  const options = {
    description,
    icon,
    ...(action && { action: { label: action.label, onClick: action.onClick } }),
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
