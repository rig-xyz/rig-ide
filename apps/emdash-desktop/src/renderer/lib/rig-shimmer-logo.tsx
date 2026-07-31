import { useId } from 'react';
import { NATURAL_HEIGHT, NATURAL_WIDTH, RIG_PATH } from '@renderer/lib/rig-logo';

export function RigShimmerLogo({
  className,
  height = NATURAL_HEIGHT,
  color = 'currentColor',
  shimmerColor = 'white',
}: {
  className?: string;
  height?: number;
  color?: string;
  shimmerColor?: string;
}) {
  const uid = useId();
  const gradientId = `logo-shimmer-${uid.replace(/:/g, '')}`;
  const width = (height / NATURAL_HEIGHT) * NATURAL_WIDTH;
  const prefersReduced =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 256 256"
      fill={`url(#${gradientId})`}
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1="-256"
          y1="-128"
          x2="0"
          y2="128"
        >
          <stop offset="0%" stopColor={color} stopOpacity="1" />
          <stop offset="25%" stopColor={color} stopOpacity="1" />
          <stop offset="50%" stopColor={shimmerColor} stopOpacity="1" />
          <stop offset="75%" stopColor={color} stopOpacity="1" />
          <stop offset="100%" stopColor={color} stopOpacity="1" />
          {!prefersReduced && (
            <animateTransform
              attributeName="gradientTransform"
              type="translate"
              values="0 0; 512 0; 512 0"
              keyTimes="0; 0.9; 1"
              dur="7s"
              repeatCount="indefinite"
            />
          )}
        </linearGradient>
      </defs>
      <path d={RIG_PATH} />
    </svg>
  );
}
