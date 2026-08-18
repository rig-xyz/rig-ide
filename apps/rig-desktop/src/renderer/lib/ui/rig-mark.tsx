/**
 * The hub's mark (`~/Code/rig/hub/web/src/components/logo.tsx`), inlined as
 * `currentColor` SVG — agent identity in comment threads is the rig mark, not
 * a generic bot glyph (lucide's `Bot` is banned per the design system).
 */
export function RigMark({ size = 12, className }: { size?: number; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill="none"
      className={className}
      aria-hidden
    >
      <path
        d="M 256 256 L 128 256 L 0 128 L 128 128 Z M 256 128 L 128 128 L 0 0 L 128 0 Z"
        fill="currentColor"
      />
    </svg>
  );
}
