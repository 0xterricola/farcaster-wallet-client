import {
  AUDIO_SPACE_EVENTS,
  createAudioSpaceTelemetryId,
  useAudioRoomsList,
  useScheduledAudioRoomsList,
} from 'farcaster-client-hooks';
import { Mic, Users } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef } from 'react';

import { BorderedMainContent } from '~/components/BorderedMainContent';
import { LoadingIndicator } from '~/components/loaders/LoadingIndicator';
import { Page } from '~/components/page/Page';
import { NodeCannotAnswerPanel } from '~/components/snapchain/NodeCannotAnswerPanel';
import { SpaceCard } from '~/components/spaces/SpaceCard';
import { useCachedCurrentUser } from '~/hooks/data/useCachedCurrentUser';
import { useNavigate } from '~/hooks/navigation/useNavigate';
import { useSearchParams } from '~/hooks/navigation/useSearchParams';
import { nodeCannotAnswer } from '~/snapchain/nodeApi/nodeCannotAnswer';
import { trackWebAudioSpaceEvent } from '~/utils/audioSpaceInstrumentation';
import { prioritizeFollowedHostsAndFilterBlockedHosts } from '~/utils/audioSpaceRoomOrdering';

/**
 * Audio rooms — the fork's `/~spaces` list, told the truth.
 *
 * WHAT WAS WRONG
 * This page wore the name "Spaces" and offered a create button. Both were
 * false. A space in Fiddy is **Together** (`/~together`): you name one, your
 * Farcaster identity joins it, and a board is shared — the nav entry for
 * "Spaces" points there now. *This* is the fork's other thing: live **audio
 * rooms**, a Farcaster-hosted product a node-backed client has neither a read
 * nor a write for (`~/snapchain/nodeApi/hostedRoutes` says so for
 * `/v1/audio-rooms`). So the old "Start a Space" button asked the seam for
 * `POST /v1/audio-rooms` and could only ever answer with a 501 sentence about
 * signing and sending — an offer that could not work, in the one place a user
 * goes to make something. The button is gone and nothing here fires that
 * request (`CreateSpaceModal` went with it, in all three of its variants:
 * start now, schedule, and the join that followed).
 *
 * WHAT THE PAGE DOES NOW
 *   - it says its own name ("Audio rooms"), and that they are not here yet;
 *   - it offers the surface that *does* create something — Spaces/Together;
 *   - the list keeps working the day something can serve it, and until then a
 *     refusal is shown as the refusal it is: the adapter's own sentence via
 *     `NodeCannotAnswerPanel`, never as an empty list, which would read as
 *     "nobody is live" when the truth is "this cannot be read here".
 */
const tabs = ['Live now', 'Upcoming'] as const;
type Tab = (typeof tabs)[number];

const SpacesPage: React.FC = React.memo(() => {
  const navigate = useNavigate();
  const { tab: tabSearchParam } = useSearchParams('spacesDiscovery');
  const tab: Tab = tabSearchParam === 'upcoming' ? 'Upcoming' : 'Live now';
  const currentUser = useCachedCurrentUser();
  const telemetrySessionIdRef = useRef(
    createAudioSpaceTelemetryId('spaces_page'),
  );
  const telemetryDedupeRef = useRef<Map<string, number>>(new Map());

  const {
    data: liveRooms,
    isLoading: isLoadingLive,
    error: liveError,
    refetch: refetchLive,
  } = useAudioRoomsList();
  const {
    data: scheduledRooms,
    isLoading: isLoadingScheduled,
    error: scheduledError,
    refetch: refetchScheduled,
  } = useScheduledAudioRoomsList({
    enabled: tab === 'Upcoming',
  });
  const sortedLiveRooms = useMemo(
    () => prioritizeFollowedHostsAndFilterBlockedHosts(liveRooms),
    [liveRooms],
  );
  const sortedScheduledRooms = useMemo(
    () => prioritizeFollowedHostsAndFilterBlockedHosts(scheduledRooms),
    [scheduledRooms],
  );

  /* `501` when the adapter cannot read this at all, `502` when the node was
     asked and did not answer (see `nodeCannotAnswer`). Either way the sentence
     goes on screen — and only a `502` gets a "Try again", because only a
     timeout can be changed by asking again. */
  const liveRefusal = nodeCannotAnswer(liveError);
  const scheduledRefusal = nodeCannotAnswer(scheduledError);

  const openSpaces = useCallback(() => {
    navigate({ to: 'together', params: {} });
  }, [navigate]);

  const handleTabChange = useCallback(
    (nextTab: Tab) => {
      navigate({
        to: 'spacesDiscovery',
        params: {},
        searchParams: {
          tab: nextTab === 'Upcoming' ? 'upcoming' : 'live',
        },
      });
    },
    [navigate],
  );

  useEffect(() => {
    trackWebAudioSpaceEvent({
      eventName: AUDIO_SPACE_EVENTS.listViewed,
      context: {
        spaceSessionId: telemetrySessionIdRef.current,
        viewerFid: currentUser?.fid,
        platform: 'web',
        entrySource: 'spaces_list',
      },
      properties: {
        tab,
        liveCount: liveRooms?.length ?? 0,
        upcomingCount: scheduledRooms?.length ?? 0,
      },
      dedupeMap: telemetryDedupeRef.current,
      dedupeKey: `web-list-viewed-${tab}-${liveRooms?.length ?? 0}-${scheduledRooms?.length ?? 0}`,
      dedupeWindowMs: 2000,
    });
  }, [currentUser?.fid, liveRooms?.length, scheduledRooms?.length, tab]);

  return (
    <Page meta={{ title: 'Audio rooms' }}>
      <BorderedMainContent>
        {/* Header */}
        <div className="bg-app/95 sticky top-0 z-20 border-b backdrop-blur border-faint">
          <div className="flex items-center justify-between px-4 py-3">
            <div className="flex items-baseline gap-2">
              <div className="text-[20px] font-bold text-default">
                Audio rooms
              </div>
              <span className="fiddy-soon">soon</span>
            </div>
            <button
              type="button"
              data-fiddy="open-spaces"
              onClick={openSpaces}
              className="inline-flex items-center justify-center gap-1.5 rounded-full border border-transparent px-[0.9333rem] py-[0.4333rem] text-sm font-semibold bg-action-primary text-light hover:opacity-90"
            >
              <Users size={12} />
              Open Spaces
            </button>
          </div>
          {/* Tabs */}
          <div className="flex">
            {tabs.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => handleTabChange(t)}
                className={`relative flex-1 px-4 py-3 text-center text-[14px] font-medium transition-colors hover:bg-overlay-light ${
                  tab === t ? 'text-default' : 'text-faint'
                }`}
              >
                {t}
                {tab === t && (
                  <span className="absolute inset-x-0 bottom-0 mx-auto h-[3px] w-14 rounded-full bg-action-primary" />
                )}
              </button>
            ))}
          </div>
        </div>

        {/* What this page is, and where a space actually lives. */}
        <div className="px-4 py-3">
          <p className="fiddy-honest-note" data-fiddy="audio-rooms-honest">
            <Mic aria-hidden="true" />
            <span>
              Live audio rooms are hosted by the Farcaster app, and Fiddy
              can&rsquo;t carry one yet &mdash; so nothing here starts, joins or
              schedules anything, and there is no button pretending otherwise.
              Your spaces are in Spaces: one project, one board, your people.
            </span>
          </p>
        </div>

        {/* Content */}
        {tab === 'Live now' && (
          <>
            {liveRefusal ? (
              <NodeCannotAnswerPanel
                label="Audio rooms"
                reason={liveRefusal.message}
                {...(liveRefusal.retryable ? { onRetry: refetchLive } : {})}
              />
            ) : isLoadingLive ? (
              <div className="flex min-h-[200px] items-center justify-center">
                <LoadingIndicator />
              </div>
            ) : sortedLiveRooms.length === 0 ? (
              <EmptyState message="No live audio rooms right now." />
            ) : (
              <div>
                {sortedLiveRooms.map((room) => (
                  <SpaceCard
                    key={room.id}
                    room={room}
                    viewerFid={currentUser?.fid}
                  />
                ))}
              </div>
            )}
          </>
        )}
        {tab === 'Upcoming' && (
          <>
            {scheduledRefusal ? (
              <NodeCannotAnswerPanel
                label="Audio rooms"
                reason={scheduledRefusal.message}
                {...(scheduledRefusal.retryable
                  ? { onRetry: refetchScheduled }
                  : {})}
              />
            ) : isLoadingScheduled ? (
              <div className="flex min-h-[200px] items-center justify-center">
                <LoadingIndicator />
              </div>
            ) : sortedScheduledRooms.length === 0 ? (
              <EmptyState message="No upcoming audio rooms." />
            ) : (
              <div>
                {sortedScheduledRooms.map((room) => (
                  <SpaceCard
                    key={room.id}
                    room={room}
                    viewerFid={currentUser?.fid}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </BorderedMainContent>
    </Page>
  );
});

SpacesPage.displayName = 'SpacesPage';

const EmptyState: React.FC<{ message: string }> = ({ message }) => (
  <div className="px-6 py-16 text-center">
    <div className="mb-2 text-[15px] font-medium text-default">
      No audio rooms here
    </div>
    <div className="text-[13px] text-faint">{message}</div>
  </div>
);

export { SpacesPage };
