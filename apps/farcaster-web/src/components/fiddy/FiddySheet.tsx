/**
 * One screen, one idea.
 *
 * Every Fiddy setup screen is this shape: the mark, where you are, one
 * sentence of headline, one short paragraph, whatever the step needs, exactly
 * one primary action, and one quiet way out. The rules the copy follows are in
 * the positioning brief — no infrastructure words anywhere on these screens.
 *
 * The same component is used by the onboarding flow and by the two sheets you
 * can reopen later, so a screen cannot drift into a second visual language.
 */

import React, { memo, ReactNode, RefObject } from 'react';

import { FiddyEgg } from '~/components/fiddy/FiddyEgg';
import { FiddyHeroStage } from '~/components/fiddy/FiddyHeroStage';

export interface FiddySheetAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** `data-fiddy` value for the button, so a test or a probe can name it. */
  testId?: string;
}

export interface FiddySheetProps {
  title: ReactNode;
  sub?: ReactNode;
  children?: ReactNode;
  primary?: FiddySheetAction | null;
  /**
   * The second loud action, when a screen really has two ways forward.
   *
   * Drawn under the primary and styled with the same weight but no highlight,
   * because a screen with two equal primaries says nothing. Used by the front
   * door for "Say hi": setting up an agent is a real way forward, but public
   * reading stays the one primary action. Never a replacement for the quiet
   * way out, which stays quiet.
   */
  secondary?: FiddySheetAction | null;
  /**
   * Draw the primary action as the thing that just became the point of the
   * screen. Set only when something the visitor did has earned it — a filled-in
   * field, a first reply from their agent — never on arrival, because a button
   * that is loud before anything happened says nothing.
   */
  primaryHighlight?: boolean;
  /** The quiet way out: a plain text button, never a second loud one. */
  quiet?: FiddySheetAction | null;
  /** Small honest print under the actions. */
  note?: ReactNode;
  /** Mascot presence: a hero egg, a small one, or none. */
  egg?: 'hero' | 'small' | 'none';
  /**
   * The real 3D Fiddy, where a screen has earned the weight of it.
   *
   * `hero` draws the turnable model in the mascot slot instead of the drawn egg
   * — the front door's stage. A screen that wants the model small (beside a
   * field, say) puts `FiddyHeroStage` where it belongs in its own layout, since
   * "beside the form" is a place this component does not have an opinion about.
   */
  model?: 'hero' | null;
  /** "Step 2 of 4" — omitted on the first and last screens. */
  step?: { index: number; total: number } | null;
  /** Identifies the screen for verification and for tests. */
  name?: string;
  wide?: boolean;
  /** The heading takes focus when a step becomes the current screen. */
  titleRef?: RefObject<HTMLHeadingElement | null>;
}

export const FiddySheet = memo<FiddySheetProps>(
  ({
    title,
    sub,
    children,
    primary = null,
    secondary = null,
    primaryHighlight = false,
    quiet = null,
    note = null,
    egg = 'none',
    model = null,
    step = null,
    name,
    wide = false,
    titleRef,
  }) => (
    <div
      className="fiddy-sheet"
      data-fiddy="sheet"
      data-fiddy-step={name ?? undefined}
    >
      <div className="fiddy-sheet-top">
        <img
          src="/brand/fiddy-logo-dark.png"
          alt="fiddy"
          className="fiddy-sheet-mark"
          width={1600}
          height={439}
        />
        {step ? (
          <span className="fiddy-step-count" data-fiddy="step-count">
            Step {step.index} of {step.total}
          </span>
        ) : (
          <span />
        )}
      </div>

      <div
        className={`fiddy-sheet-body ${wide ? 'fiddy-sheet-body-wide' : ''}`}
      >
        {model === 'hero' ? <FiddyHeroStage variant="hero" /> : null}
        {egg === 'hero' ? <FiddyEgg size={112} /> : null}
        {egg === 'small' ? <FiddyEgg size={76} /> : null}

        <h1 className="fiddy-sheet-title" ref={titleRef} tabIndex={-1}>
          {title}
        </h1>
        {sub ? <p className="fiddy-sheet-sub">{sub}</p> : null}

        {children ? (
          <div className="fiddy-sheet-content">{children}</div>
        ) : null}

        {primary || secondary || quiet ? (
          <div className="fiddy-sheet-actions">
            {primary ? (
              <button
                type="button"
                className={`fiddy-primary-btn ${primaryHighlight ? 'fiddy-primary-btn-hot' : ''}`}
                data-highlighted={primaryHighlight ? 'true' : undefined}
                data-fiddy={primary.testId}
                onClick={primary.onClick}
                disabled={primary.disabled}
              >
                {primary.label}
              </button>
            ) : null}
            {secondary ? (
              <button
                type="button"
                className="fiddy-secondary-btn"
                data-fiddy={secondary.testId}
                onClick={secondary.onClick}
                disabled={secondary.disabled}
              >
                {secondary.label}
              </button>
            ) : null}
            {quiet ? (
              <button
                type="button"
                className="fiddy-quiet-btn"
                onClick={quiet.onClick}
                disabled={quiet.disabled}
              >
                {quiet.label}
              </button>
            ) : null}
          </div>
        ) : null}

        {note ? <p className="fiddy-sheet-note">{note}</p> : null}
      </div>
    </div>
  ),
);

FiddySheet.displayName = 'FiddySheet';
