/**
 * The sidebar entry for the agent surface.
 *
 * Two states a browser can know without a network call:
 *   unhatched — no agent service paired here (muted egg outline)
 *   hatched   — a session exists (chartreuse egg with a check)
 *
 * Whether the agent is awake is the agent surface's job to show; putting a poll
 * in the navigation would be a request per render and a lie whenever it failed.
 */

import React, { memo } from 'react';

import { NavLink } from '~/components/links/NavLink';
import { NavLinkIcon } from '~/components/links/NavLinkIcon';
import { NavLinkLabel } from '~/components/links/NavLinkLabel';
import { useAgentSession } from '~/hooks/agent/useAgentSession';

export type AgentNavState = 'unhatched' | 'hatched';

const EggIcon = ({ state }: { state: AgentNavState }) => {
  const hatched = state === 'hatched';
  return (
    <span className="relative block h-5 w-5" aria-hidden="true">
      <svg
        className="h-full w-full"
        viewBox="0 0 24 24"
        fill={hatched ? '#d4ff3f' : 'none'}
        stroke={hatched ? '#1a1c10' : 'currentColor'}
        strokeWidth={1.5}
      >
        <path d="M12 3C7.5 3 4 7.5 4 12c0 10 8 11 16 11S20 22 20 12c0-4.5-3.5-9-8-9z" />
      </svg>
      {hatched ? (
        <svg
          className="absolute -bottom-0.5 -right-0.5 h-3 w-3"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#d4ff3f"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 13l5 5L20 7" />
        </svg>
      ) : null}
    </span>
  );
};

export interface AgentNavItemProps {
  state: AgentNavState;
}

export const AgentNavItem = memo<AgentNavItemProps>(({ state }) => {
  const label = state === 'hatched' ? 'Agent' : 'Hatch an agent';
  return (
    <NavLink to="agent" params={{}} searchParams={{}} title={label}>
      <NavLinkIcon>
        <div className="relative translate-y-[-0.75px]">
          <EggIcon state={state} />
        </div>
      </NavLinkIcon>
      <NavLinkLabel>{label}</NavLinkLabel>
    </NavLink>
  );
});

AgentNavItem.displayName = 'AgentNavItem';

/** Wired variant for the sidebar: reads the session from storage only. */
export const AgentNavEntry = memo(() => {
  const { status } = useAgentSession();
  return <AgentNavItem state={status === 'paired' ? 'hatched' : 'unhatched'} />;
});

AgentNavEntry.displayName = 'AgentNavEntry';
