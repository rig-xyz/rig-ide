import * as React from 'react';
import { cn } from '@renderer/lib/utils';

const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<'textarea'>>(
  function Textarea({ className, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        data-slot="textarea"
        className={cn(
          'border-border-hairline bg-bg-1 text-text-primary placeholder:text-text-muted focus-visible:border-accent flex field-sizing-content min-h-16 w-full rounded-control border px-2.5 py-2 text-sm outline-none transition-colors disabled:pointer-events-none disabled:opacity-50',
          className
        )}
        {...props}
      />
    );
  }
);

export type TextareaProps = React.ComponentProps<'textarea'>;

export { Textarea };
