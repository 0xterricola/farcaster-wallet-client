/**
 * The Fiddy mascot: an egg with a smile, the same mark the agent surface and
 * the design use. It is drawn (not an image) so it takes the accent colour from
 * CSS and stays sharp at every size.
 *
 * Deliberately not a person and not a face with eyes: this is the "it hatches
 * into your agent" idea, one shape, no gender, no mascot personality to voice.
 */

import React, { memo } from 'react';

export interface FiddyEggProps {
  /** Diameter in px. 104 in the design's own roundel, 88 on a phone. */
  size?: number;
  /** Wrap in the design's roundel (glass circle) instead of a bare glyph. */
  bare?: boolean;
  className?: string;
}

const EggGlyph = memo<{ size: number }>(({ size }) => (
  <svg
    width={Math.round(size * 0.5)}
    height={Math.round(size * 0.5)}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.4}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 3.5c3.2 3.5 5.5 6.9 5.5 9.7a5.5 5.5 0 1 1-11 0c0-2.8 2.3-6.2 5.5-9.7z" />
    <path d="m9.2 12.4 1.5 1.3 1.2-1.7 1.4 1.5" />
  </svg>
));

EggGlyph.displayName = 'EggGlyph';

export const FiddyEgg = memo<FiddyEggProps>(
  ({ size = 104, bare = false, className = '' }) => {
    if (bare) {
      return (
        <span
          className={`fiddy-egg-bare ${className}`}
          style={{
            width: size,
            height: size,
            color: 'var(--fiddy-accent-deep)',
          }}
        >
          <EggGlyph size={size} />
        </span>
      );
    }
    return (
      <span
        className={`fiddy-egg-wrap ${className}`}
        style={{ width: size, height: size }}
        data-fiddy="egg"
      >
        <EggGlyph size={size} />
      </span>
    );
  },
);

FiddyEgg.displayName = 'FiddyEgg';
