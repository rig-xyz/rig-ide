import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { cn } from '@renderer/lib/utils';

/**
 * A quiet, centered modal — `@base-ui/react/dialog` restyled to the rig
 * token set (mirrors `tooltip.tsx`'s wrapper pattern). Deliberately a small
 * surface (Root/Portal/Backdrop/Popup/Title/Close only): this app's first
 * use is the Settings modal, which needs a title, a close control, and a
 * content area — not the fuller header/footer/description API emdash's own
 * `dialog.tsx` carries for its many settings-app-style dialogs.
 */
function Dialog(props: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogPortal(props: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogBackdrop({ className, ...props }: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-backdrop"
      className={cn(
        // Charter v2 motion: backdrop fades 150ms both ways via Base UI's
        // data-starting/ending-style hooks (they exist for exactly this and
        // went unused until slice 1). transition-opacity keeps it
        // interruptible; motion-reduce collapses it to instant.
        'fixed inset-0 z-50 bg-black/30 transition-opacity duration-150 ease-out motion-reduce:transition-none',
        'data-[starting-style]:opacity-0 data-[ending-style]:opacity-0',
        className
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  /** Override for the backdrop's own className — a dialog opened ON TOP of another (base-ui's Root supports nesting) passes `bg-transparent` here so the two backdrops don't double-dim the screen; the outer dialog's own opaque backdrop already covers it. Still renders a real (just invisible) Backdrop, so click-outside/pointer-blocking behavior is unchanged. */
  backdropClassName,
  children,
  ...props
}: DialogPrimitive.Popup.Props & { backdropClassName?: string }) {
  return (
    <DialogPortal>
      <DialogBackdrop className={backdropClassName} />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          // shadow-modal (charter v2): dialogs sit at the top of the
          // elevation ladder, above menus' shadow-float. Enter/exit: a
          // 150ms fade + slight settle from scale(0.98), never from 0 —
          // transitions (not keyframes) so a fast close mid-open reverses
          // smoothly instead of jumping.
          'border-border-hairline bg-bg-1 rounded-card shadow-modal fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-4rem)] w-full max-w-md -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden border outline-none',
          // Tailwind v4 maps scale-* to the standalone `scale` property (not
          // `transform`), so the transition must name it explicitly — the
          // close "flash" was scale snapping while opacity animated.
          'transition-[opacity,scale] duration-150 ease-out motion-reduce:transition-none',
          'data-[starting-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[ending-style]:scale-[0.98]',
          className
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('text-text-primary text-sm font-medium', className)}
      {...props}
    />
  );
}

function DialogClose(props: DialogPrimitive.Close.Props) {
  return (
    <DialogPrimitive.Close
      data-slot="dialog-close"
      aria-label="Close"
      className="text-text-muted hover:bg-bg-2 hover:text-text-primary rounded-control flex size-6 shrink-0 items-center justify-center transition-colors"
      {...props}
    >
      <X className="size-3.5" strokeWidth={1.5} />
    </DialogPrimitive.Close>
  );
}

export { Dialog, DialogPortal, DialogBackdrop, DialogContent, DialogTitle, DialogClose };
