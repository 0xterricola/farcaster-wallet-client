/**
 * A look, drawn as Fiddy itself in that look's colours.
 *
 * This is the whole preview: no screenshot, no picture file, nothing fetched.
 * The markup is shapes and the colours come from the look's own variables, so
 * the same component draws the look in the picker, the look being edited, a
 * stranger's shared look, and the card a shared link leaves in a feed.
 *
 * It reads `--fiddy-*` off its own element (see `lookVars()`), which is why one
 * component can draw a look that is NOT the one being worn.
 */

import React from 'react';

import { Look, lookVars } from '~/utils/lookTheme';

type LookPreviewProps = {
  look: Look;
  className?: string;
  /** `bar` is the wide header row; `card` is the feed's small stack. */
  variant?: 'bar' | 'card';
};

const LookPreview: React.FC<LookPreviewProps> = React.memo(
  ({ look, className, variant = 'card' }) => {
    const vars = lookVars(look) as React.CSSProperties;

    return (
      <div
        className={`fiddy-look ${variant === 'bar' ? 'w-full' : 'w-full'} ${className ?? ''}`}
        style={vars}
        data-fiddy="look-preview"
        aria-hidden="true"
      >
        <div className="fiddy-look-top">
          <span className="fiddy-look-dot" />
          <span className="fiddy-look-bar w-16" />
          <span className="fiddy-look-bar ml-auto w-6" />
        </div>
        <div className="fiddy-look-body">
          <div className="fiddy-look-row">
            <span className="fiddy-look-face" />
            <span className="fiddy-look-lines">
              <span className="fiddy-look-line w-3/4" />
              <span className="fiddy-look-line-dim w-1/2" />
            </span>
          </div>
          <div className="fiddy-look-row">
            <span className="fiddy-look-line-dim w-full" />
          </div>
          <div className="fiddy-look-actions">
            <span className="fiddy-look-like text-xs">♥</span>
            <span className="fiddy-look-recast text-xs">↻</span>
            <span className="fiddy-look-chip ml-auto">Say hi</span>
          </div>
        </div>
      </div>
    );
  },
);

LookPreview.displayName = 'LookPreview';

/** The same look as a row of its own colours: what a list can show at a glance. */
const LookSwatches: React.FC<{ look: Look; className?: string }> = ({
  look,
  className,
}) => (
  <span
    className={`fiddy-look-swatches ${className ?? ''}`}
    data-fiddy="look-swatches"
  >
    {(['bg', 'card', 'ink', 'accent', 'like'] as const).map((token) => (
      <span
        key={token}
        className="fiddy-look-swatch"
        style={{
          background: look[token] ?? 'transparent',
        }}
      />
    ))}
  </span>
);

LookSwatches.displayName = 'LookSwatches';

export { LookPreview, LookSwatches };
