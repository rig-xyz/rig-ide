import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '@renderer/lib/utils';

/**
 * Restyled to the rig token set (`docs/design-system.md`): teal (`--accent`)
 * only on the primary variant, per the accent budget — every other variant
 * stays neutral (hairline border + `bg-2` hover, never an accent wash).
 */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-control border border-transparent text-sm font-medium whitespace-nowrap transition-colors outline-none select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5 focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2",
  {
    variants: {
      variant: {
        default: 'bg-accent text-accent-ink hover:opacity-90',
        outline:
          'border-border-hairline bg-transparent text-text-secondary hover:bg-bg-2 hover:text-text-primary',
        secondary: 'bg-bg-2 text-text-secondary hover:text-text-primary',
        ghost: 'text-text-secondary hover:bg-bg-2 hover:text-text-primary',
        destructive: 'border-danger/40 text-danger hover:bg-danger/10',
      },
      size: {
        default: 'h-8 px-3',
        sm: 'h-7 px-2.5 text-xs',
        xs: 'h-6 px-2 text-xs',
        icon: 'size-8',
        'icon-sm': 'size-6',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

const Button = React.forwardRef<
  HTMLButtonElement,
  ButtonPrimitive.Props & VariantProps<typeof buttonVariants>
>(function Button({ className, variant = 'default', size = 'default', ...props }, ref) {
  return (
    <ButtonPrimitive
      ref={ref}
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
});

export { Button, buttonVariants };
