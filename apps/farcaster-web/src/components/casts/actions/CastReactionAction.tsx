import cn from 'classnames';
import { formatShorthandNumber } from 'farcaster-client-hooks';
import React from 'react';

export type CastReactionActionProps = {
  activeColor?: string;
  /**
   * The count behind this action, or `undefined` when it has NOT been read.
   *
   * A node-backed feed paints before its per-cast counts are read (card
   * t_0d0e9330), so "absent" is a real state and not a zero: an unread count
   * draws no number at all. `0` is a count somebody read and it renders as the
   * fork always did.
   */
  count?: number;
  /**
   * The `data-fiddy-count` name for this count (`likes`, `recasts`, …), when the
   * surface knows it.
   *
   * The action bar draws a bare number with no label of its own, so this is what
   * lets a probe ask "is the like count on screen yet?" of a cast rendered here
   * — the same question `CastDetails`' own markers answer. It is also the only
   * count a non-focused cast draws: `CastDetails` is rendered by `FocusedCast`
   * alone, so before this the feed's numbers were unreadable from the DOM and a
   * count that arrived behind the paint could not be told from one that never
   * arrived (measured, card t_0d0e9330).
   */
  countMarker?: 'likes' | 'recasts' | 'replies' | 'quotes';
  disabled?: boolean;
  icon: React.ReactNode;
  isActive?: boolean;
  isFocused: boolean;
  onClick?: (e: React.SyntheticEvent) => void;
  variant?: 'green' | 'red' | 'purple' | 'blue' | undefined;
};

function CastReactionAction(props: CastReactionActionProps) {
  const {
    onClick,
    icon,
    isActive,
    isFocused,
    count,
    countMarker,
    variant,
    disabled,
  } = props;
  const activeStyle =
    isActive && !disabled && props.activeColor
      ? { color: props.activeColor }
      : undefined;

  return (
    <div
      className={cn(
        'group flex w-max flex-row items-center text-sm text-tertiary',
        !disabled && 'cursor-pointer',
      )}
      onClick={(e) => {
        // Recast are triggered through RecastOptions and they don't have an onclick function
        if (!onClick) {
          return;
        }

        e.stopPropagation();
        if (!disabled) {
          onClick(e);
        }
      }}
    >
      <div
        className={cn(
          'group flex flex-row items-center justify-center rounded-full p-2 transition-colors',
          !isActive && 'text-tertiary',
          !disabled &&
            'hover:bg-gray-200 group-hover:bg-gray-200 dark:hover:bg-overlay-medium dark:group-hover:bg-overlay-medium',
          isActive &&
            (variant === undefined || variant === 'purple') &&
            'text-brand ',
          isActive && variant === 'red' && 'text-danger',
          isActive && variant === 'green' && 'text-success',
          isActive && variant === 'blue' && 'text-informative',
        )}
        style={activeStyle}
      >
        {icon}
      </div>
      {count === undefined ? null : (
        <span
          className={cn(
            'group ml-[2px] inline-flex pr-1.5 text-center text-sm transition-colors group-hover:text-muted',
            !isActive && 'text-tertiary',
            isActive &&
              (variant === undefined || variant === 'purple') &&
              'text-brand ',
            isActive && variant === 'red' && 'text-danger',
            isActive && variant === 'green' && 'text-success',
            isActive && variant === 'blue' && 'text-informative',
            disabled && '!text-tertiary',
            (isFocused || count === 0) && 'hidden',
          )}
          style={activeStyle}
          {...(countMarker
            ? { 'data-fiddy-count': countMarker, title: count.toLocaleString() }
            : {})}
        >
          {formatShorthandNumber(count)}
        </span>
      )}
    </div>
  );
}

CastReactionAction.displayName = 'CastReactionAction';

export { CastReactionAction };
