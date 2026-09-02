interface ConductorMarkProps {
  size?: number;
  color?: string;
}

/**
 * The app's mark: a running-command chevron plus a terminal cursor.
 * Matches packages/desktop/build/icon.png and public/favicon.svg — keep
 * all three in sync if the glyph changes.
 */
export function ConductorMark({ size = 20, color = "var(--mantine-color-green-5)" }: ConductorMarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M8 8 L13 12 L8 16"
        stroke={color}
        strokeWidth={2.1}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <rect x="14.5" y="14.5" width="4.5" height="2.1" rx="0.5" fill={color} />
    </svg>
  );
}
