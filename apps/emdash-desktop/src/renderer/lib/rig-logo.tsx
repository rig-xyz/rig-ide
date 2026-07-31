// The rig mark. Geometry is the canonical one shared with the web hub
// (hub/web/src/components/logo.tsx) and the app icon (assets/images/rig/rig-icon.svg);
// keep the path in sync with those if the mark ever changes.
export const NATURAL_WIDTH = 256;
export const NATURAL_HEIGHT = 256;

export const RIG_PATH =
  'M 256 256 L 128 256 L 0 128 L 128 128 Z M 256 128 L 128 128 L 0 0 L 128 0 Z';

export function RigLogo({
  className,
  height = NATURAL_HEIGHT,
  color = 'currentColor',
}: {
  className?: string;
  height?: number;
  color?: string;
}) {
  const width = (height / NATURAL_HEIGHT) * NATURAL_WIDTH;

  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 256 256"
      fill={color}
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d={RIG_PATH} />
    </svg>
  );
}
