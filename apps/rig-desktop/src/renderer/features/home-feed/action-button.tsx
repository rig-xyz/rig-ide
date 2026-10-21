import { ArrowRight, type LucideIcon } from 'lucide-react';
import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from 'react';
import { cn } from '@renderer/lib/utils';

/**
 * Home's one button. Every button carries an icon and moves a little when
 * you reach for it (after amicro's "slide arrow"): it grows a touch and
 * opens up, its icon slides out to the left and an arrow slides in after
 * the label, so the button points where it goes. Buttons that don't go
 * anywhere (Undo, Skip, Send) keep their icon and give it a small nudge
 * instead: Undo turns back, Send lifts off. Pressing settles it down.
 * Keyboard focus moves it the same way hover does; reduced motion keeps the
 * color change and drops the movement (`home-feed.css`).
 */

export type ActionMotion = 'slide' | 'undo' | 'send' | 'nudge';

export interface ActionButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children'
> {
  icon: LucideIcon;
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'quiet';
  size?: 'sm' | 'md';
  motion?: ActionMotion;
}

const VARIANT = {
  primary: 'hf-btn-primary bg-accent text-accent-ink border-accent font-medium',
  secondary:
    'hf-btn-secondary border-border-hairline bg-bg-1 text-text-primary hover:border-border-strong',
  quiet:
    'border-transparent bg-transparent text-text-secondary hover:bg-bg-2 hover:text-text-primary',
};

export const ActionButton = forwardRef<HTMLButtonElement, ActionButtonProps>(function ActionButton(
  {
    icon: Icon,
    children,
    variant = 'secondary',
    size = 'md',
    motion = 'slide',
    className,
    type = 'button',
    ...rest
  },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      data-motion={motion}
      data-size={size}
      {...rest}
      className={cn(
        'hf-btn inline-flex shrink-0 items-center justify-center rounded-[9px] border whitespace-nowrap disabled:pointer-events-none disabled:opacity-50',
        size === 'md' ? 'h-8 text-sm' : 'h-7 text-meta',
        VARIANT[variant],
        className
      )}
    >
      <span aria-hidden className="hf-btn-lead">
        <Icon className={size === 'md' ? 'size-[15px]' : 'size-3.5'} strokeWidth={2} />
      </span>
      <span className="hf-btn-label">{children}</span>
      {motion === 'slide' && (
        <span aria-hidden className="hf-btn-trail">
          <ArrowRight className={size === 'md' ? 'size-[15px]' : 'size-3.5'} strokeWidth={2.2} />
        </span>
      )}
    </button>
  );
});
