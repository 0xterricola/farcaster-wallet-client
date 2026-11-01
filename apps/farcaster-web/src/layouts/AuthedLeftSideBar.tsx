import { GearIcon } from '@primer/octicons-react';
import { useUnseen } from 'farcaster-client-hooks';
import {
  Archive,
  BellIcon,
  CodeIcon,
  Grid3X3Icon,
  HomeIcon,
  Megaphone,
  Send,
  Server,
  UserPlusIcon,
  Users,
  Wallet,
} from 'lucide-react';
import React from 'react';

import { AgentNavEntry } from '~/components/agent/AgentNavItem';
import { AvatarImage } from '~/components/avatar/AvatarImage';
import { AccountSwitcherEntry } from '~/components/fiddy/accounts/AccountSwitcher';
import { NavLink } from '~/components/links/NavLink';
import { NavLinkBadge } from '~/components/links/NavLinkBadge';
import { NavLinkIcon } from '~/components/links/NavLinkIcon';
import { NavLinkLabel } from '~/components/links/NavLinkLabel';
import { ChannelNavLinks } from '~/components/sidebar/ChannelNavLinks';
import { NodeStatusPill } from '~/components/snapchain/NodeStatusPill';
import { useUserAppContext } from '~/contexts/UserAppContextProvider';
import { useCurrentUser } from '~/hooks/data/useCurrentUser';
import { useCurrentUserProfileCastsLinkProps } from '~/hooks/navigation/useCurrentUserProfileCastsLinkProps';
import { LeftSideBar } from '~/layouts/LeftSideBar';
import { LeftSideBarLogo } from '~/layouts/LeftSideBarLogo';
import { isNodeBackedClientEnabled } from '~/snapchain/nodeApi/nodeBackedClientFlag';

const AuthedLeftSideBar: React.FC = React.memo(() => {
  // Whose data the rail is showing: with the node as the source, the DM entry
  // has nothing behind it (see the note beside it further down).
  const nodeBackedClient = isNodeBackedClientEnabled();
  const {
    notificationsCount,
    inboxCount,
    channelFeedsUnseenStatus,
    countsUnavailable,
  } = useUnseen();
  const { developerModeEnabled } = useUserAppContext();
  const currentUser = useCurrentUser();

  const currentUserProfileCastsLinkProps = useCurrentUserProfileCastsLinkProps({
    title: 'Profile',
  });
  const updatesUnseenCount = channelFeedsUnseenStatus?.['fc-updates']
    ?.hasNewItems
    ? 1
    : 0;

  return (
    <LeftSideBar asideClassName="fiddy-nav" className="justify-between pb-4">
      <div className="flex grow flex-col space-y-1 xl:w-full">
        <div className="flex flex-row items-center justify-center xl:justify-between">
          <div className="block">
            <LeftSideBarLogo title="Recommended feed" />
          </div>
        </div>
        {/* Whose node answered is persistent chrome, not a settings detail:
            the collapsed (icon-only) sidebar keeps the dot, the wide one adds
            the words. */}
        <div className="my-2 flex flex-row items-center justify-center xl:justify-start">
          <NodeStatusPill
            short
            labelClassName="hidden xl:inline"
            className="xl:px-2.5"
          />
        </div>
        {/* The four surfaces Fiddy is actually about, first — then everything
            else the fork exposes, so nothing becomes unreachable. */}
        <NavLink to="homeFeed" params={{}} searchParams={{}} title="Feed">
          <NavLinkIcon>
            <div className="-translate-y-px">
              <HomeIcon size={20} />
            </div>
          </NavLinkIcon>
          <NavLinkLabel>Feed</NavLinkLabel>
        </NavLink>
        <AgentNavEntry />
        {/* The wallet is a real surface in this build, so it is a real entry —
            no "soon" tag where something actually works. */}
        <NavLink to="wallet" params={{}} searchParams={{}} title="Wallet">
          <NavLinkIcon>
            <div className="relative translate-y-[-0.75px]">
              <Wallet size={20} />
            </div>
          </NavLinkIcon>
          <NavLinkLabel>Wallet</NavLinkLabel>
        </NavLink>
        <NavLink to="settings" params={{}} searchParams={{}} title="Settings">
          <NavLinkIcon>
            <GearIcon size={20} />
          </NavLinkIcon>
          <NavLinkLabel>Settings</NavLinkLabel>
        </NavLink>
        <div className="fiddy-nav-caption">More</div>
        {/* The unseen counts are the only thing in this rail that comes from a
            read of its own (/v2/unseen, polled by UnseenProvider), and badges
            that cannot load look exactly like badges that are zero. When the
            read fails, say so where the badges would be — the poll keeps
            retrying, so the note clears itself. See UnseenProvider. */}
        {countsUnavailable && (
          <div
            className="fiddy-nav-note"
            data-fiddy="unseen-unavailable"
            role="status"
          >
            Unseen counts couldn&rsquo;t load &mdash; Farcaster didn&rsquo;t
            answer. Retrying.
          </div>
        )}
        <NavLink
          to="notifications"
          params={{}}
          searchParams={{}}
          title="Notifications"
        >
          <NavLinkIcon>
            <div className="relative translate-y-[-1.25px]">
              <BellIcon size={20} />
            </div>
          </NavLinkIcon>
          <NavLinkLabel>Notifications</NavLinkLabel>
          <NavLinkBadge count={notificationsCount} subtle={false} />
        </NavLink>
        {/* Spaces is Together — one project, one board, your people — because
            that is what a space is in Fiddy: you create one, a Farcaster
            identity joins it, and the board is shared. The entry used to point
            at the fork's Spaces (live audio rooms), which is a hosted product
            this client has neither a read nor a write for: the create button
            there asked for `POST /v1/audio-rooms` and could only ever answer
            "nothing was signed and nothing was sent". Never offer an action
            that cannot work — name what is missing where it would sit, the way
            Direct Casts above does. See ~/snapchain/nodeApi/hostedRoutes
            (`/v1/audio-rooms`) and ~/pages/spaces/SpacesPage. */}
        <NavLink to="together" params={{}} searchParams={{}} title="Spaces">
          <NavLinkIcon>
            <div className="relative translate-y-[-1.25px]">
              <Users size={20} />
            </div>
          </NavLinkIcon>
          <NavLinkLabel>Spaces</NavLinkLabel>
        </NavLink>
        <div
          className="fiddy-nav-note"
          data-fiddy="audio-rooms-soon"
          role="status"
        >
          Audio rooms <span className="fiddy-soon">soon</span>
        </div>
        <NavLink to="discover" params={{}} searchParams={{}} title="Apps">
          <NavLinkIcon>
            <div className="relative translate-y-[-1.25px]">
              <Grid3X3Icon size={20} />
            </div>
          </NavLinkIcon>
          <NavLinkLabel>Apps</NavLinkLabel>
          {/* <NavLinkBadge count={notificationsCount} subtle={false} /> */}
        </NavLink>
        {/* Direct messages are not on a Snapchain read node: the inbox is a
            hosted-API product, and this client has no session for it. So the
            link is not offered where it cannot work — the nav says what is
            missing instead of routing to a surface that cannot load. See
            ~/snapchain/nodeApi/hostedRoutes (the endpoint is classified
            `hosted` on purpose). */}
        {nodeBackedClient ? (
          <div
            className="fiddy-nav-note"
            data-fiddy="dms-unavailable"
            role="status"
          >
            Direct Casts <span className="fiddy-soon">soon</span>
          </div>
        ) : (
          <NavLink
            to="directCastsInbox"
            params={{}}
            searchParams={{}}
            title="Inbox"
          >
            <NavLinkIcon>
              <div className="translate-y-[-0.5px]">
                <Send size={20} />
              </div>
            </NavLinkIcon>
            <NavLinkLabel>Direct Casts</NavLinkLabel>
            <NavLinkBadge className="ml-4" count={inboxCount} subtle={false} />
          </NavLink>
        )}
        <NavLink
          to={'referrals'}
          params={{}}
          searchParams={{}}
          title="Referrals"
        >
          <NavLinkIcon>
            <div className="relative translate-y-[-0.75px]">
              <UserPlusIcon size={20} />
            </div>
          </NavLinkIcon>
          <NavLinkLabel>Referrals</NavLinkLabel>
        </NavLink>
        <NavLink to={'saved'} params={{}} searchParams={{}} title="Saved">
          <NavLinkIcon>
            <div className="relative translate-y-[-0.75px]">
              <Archive size={20} />
            </div>
          </NavLinkIcon>
          <NavLinkLabel>Saved</NavLinkLabel>
        </NavLink>
        {/* Demoted on purpose by the positioning pivot: reading through your
            own setup still works and is still honest chrome, but it is not
            what Fiddy leads with, so it lives under Advanced in plain words. */}
        <div className="fiddy-nav-caption">Advanced</div>
        <NavLink
          to="settingsNode"
          params={{}}
          searchParams={{}}
          title="Your own setup (Advanced)"
        >
          <NavLinkIcon>
            <div className="relative translate-y-[-0.75px]">
              <Server size={20} />
            </div>
          </NavLinkIcon>
          <NavLinkLabel>Your own setup</NavLinkLabel>
        </NavLink>
        {developerModeEnabled && (
          <NavLink
            to={'developers'}
            params={{}}
            searchParams={{}}
            title="Developers"
          >
            <NavLinkIcon>
              <div className="relative translate-y-[-0.95px]">
                <CodeIcon size={20} />
              </div>
            </NavLinkIcon>
            <NavLinkLabel>Developers</NavLinkLabel>
          </NavLink>
        )}
        <NavLink
          to="channel"
          params={{ channelKey: 'fc-updates' }}
          searchParams={{}}
          title="Updates"
        >
          <NavLinkIcon>
            <div className="translate-y-[-1.25px]">
              <Megaphone size={20} />
            </div>
          </NavLinkIcon>
          <NavLinkLabel>Updates</NavLinkLabel>
          <NavLinkBadge count={updatesUnseenCount} subtle={false} />
        </NavLink>
        <NavLink {...currentUserProfileCastsLinkProps}>
          <NavLinkIcon>
            <div className="translate-y-[-1.25px]">
              <AvatarImage
                imgUrl={currentUser.pfp?.url}
                imgAlt={currentUser.displayName || currentUser.username || ''}
                size="xs"
                className="hover:bg-transparent"
              />
            </div>
          </NavLinkIcon>
          <NavLinkLabel>Profile</NavLinkLabel>
        </NavLink>
        <div className="hidden xl:contents">
          <ChannelNavLinks />
        </div>
        {/*
          Which account this browser is acting as.
          A browser can hold more than one account now (they can be made right
          here), so "who am I?" is a question the rail has to be able to answer
          — and the answer has to be reachable without hunting through settings.
        */}
        <AccountSwitcherEntry className="fiddy-account-entry" />
      </div>
    </LeftSideBar>
  );
});

AuthedLeftSideBar.displayName = 'AuthedLeftSideBar';

export { AuthedLeftSideBar };
