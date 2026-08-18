import { useTheme } from '@renderer/lib/hooks/use-theme';
import { cn } from '@renderer/lib/utils';
import type { AgentIconAsset } from '@shared/core/agents/agent-payload';
import { pickIconVariant } from './agent-icon-variant';

/**
 * A provider's own mark (Claude, Codex, Goose, …) — ported from
 * `apps/emdash-desktop`'s `plugin-icon.tsx`, ships the same asset variants,
 * retextured onto this app's theme (`useTheme` off `<html data-theme>`
 * instead of emdash's theme store).
 *
 * Callers hand in the `AgentIconAsset` directly (from `AgentPayload`/
 * `AgentMetadata`) rather than looking it up by id internally — this app has
 * no `use-agents` store to look it up from, and every caller already has the
 * payload in hand.
 */
export function AgentIcon({
  icon,
  size = 16,
  className,
  grayscale,
}: {
  icon: AgentIconAsset;
  size?: number;
  className?: string;
  grayscale?: boolean;
}) {
  const theme = useTheme();
  const variant = pickIconVariant(icon.variants, size);
  if (!variant) return null;

  const shouldInvert = theme === 'dark' && icon.invertInDark;
  const content = theme === 'dark' && variant.dark ? variant.dark : variant.light;

  const wrapperClass = cn(
    'inline-flex shrink-0 items-center justify-center [&>svg]:h-full [&>svg]:w-full',
    grayscale && 'grayscale',
    shouldInvert && 'invert',
    className
  );

  if (icon.kind === 'image') {
    return (
      <span className={wrapperClass} style={{ width: size, height: size }}>
        <img src={content} alt={icon.alt ?? ''} width={size} height={size} />
      </span>
    );
  }

  return (
    <span
      className={wrapperClass}
      style={{ width: size, height: size }}
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: content }}
    />
  );
}
