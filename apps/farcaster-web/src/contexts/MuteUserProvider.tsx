import { Dialog } from '@headlessui/react';
import cn from 'classnames';
import { AnalyticsEvent } from 'farcaster-analytics';
import {
  getNotionLinkTarget,
  useMarkInvisible,
  useRemoveUserFromAllFeeds,
  useTrackEvent,
} from 'farcaster-client-hooks';
import React, { ReactNode, useCallback, useRef, useState } from 'react';

import { DialogBackdrop, DialogPanelContainer } from '~/components/Dialog';
import { DefaultButton } from '~/components/forms/buttons/DefaultButton';
import { ExternalLink } from '~/components/links/ExternalLink';
import { useCurrentUser } from '~/hooks/data/useCurrentUser';
import { MUTE_SPANS, setMute } from '~/snapchain/mutePreferences';
import { trackError } from '~/utils/errorUtils';
import { toast } from '~/utils/toast';

type MuteUserParams = {
  targetFid: number;
  username: string;
  source: 'direct-cast-request' | 'cast' | 'profile';
  block?: boolean;
};

export type MuteUserContextValue = {
  muteUser: (params: MuteUserParams) => Promise<{ muted: boolean }>;
};

const MuteUserContext = React.createContext<MuteUserContextValue>({
  muteUser: async () => {
    throw new Error('Must be called in MuteUserContext provider');
  },
});

export const useMuteUser = () => React.useContext(MuteUserContext);

export function MuteUserProvider({ children }: { children: ReactNode }) {
  const [params, setParams] = useState<MuteUserParams | null>(null);
  const resolveRef = useRef<(value: { muted: boolean }) => void>(undefined);

  const muteUser = useCallback(async (params: MuteUserParams) => {
    setParams(params);
    return new Promise<{ muted: boolean }>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  const handleMute = () => {
    if (resolveRef.current) {
      resolveRef.current({ muted: true });
      resolveRef.current = undefined;
    }

    setParams(null);
  };

  const handleCancel = () => {
    if (resolveRef.current) {
      resolveRef.current({ muted: false });
      resolveRef.current = undefined;
    }

    setParams(null);
  };

  return (
    <MuteUserContext.Provider value={{ muteUser }}>
      {children}
      {params && (
        <MuteUserDialog
          {...params}
          onMute={handleMute}
          onCancel={handleCancel}
        />
      )}
    </MuteUserContext.Provider>
  );
}

function MuteUserDialog({
  targetFid,
  username,
  source,
  block,
  onMute,
  onCancel,
}: MuteUserParams & {
  onMute: () => void;
  onCancel: () => void;
}) {
  const user = useCurrentUser();
  const markInvisible = useMarkInvisible();
  const removeUserFromAllFeeds = useRemoveUserFromAllFeeds();
  const [submitting, setSubmitting] = useState(false);
  /**
   * How long, as one of `MUTE_SPANS`. The last choice carries no `ms` at all,
   * which is "until I lift it" — the only one that needs no clock to stay true,
   * and so the one this starts on.
   */
  const [spanIndex, setSpanIndex] = useState(MUTE_SPANS.length - 1);
  const { trackEvent } = useTrackEvent();

  const span = MUTE_SPANS[spanIndex]!;
  const until = span.ms === undefined ? undefined : Date.now() + span.ms;

  const mute = async () => {
    try {
      setSubmitting(true);
      // The list THIS BROWSER keeps is what the read path consults, so it is
      // what has to be written first. A node holds no mute list at all, and a
      // provider that refuses the hosted write must not make the hide a lie.
      await setMute({
        fid: user.fid,
        kind: block ? 'blocks' : 'users',
        value: targetFid,
        ...(until === undefined ? {} : { until }),
      });
      // ...and the page on screen right now drops them, without waiting for a
      // read, which is what the reader just asked to see.
      removeUserFromAllFeeds({ fid: targetFid });

      // The account's own list on the hosted API is a MIRROR, applied best
      // effort: it is how another device would learn about this, but it is not
      // what this client reads to decide what to hide. A provider that cannot
      // take it (a node-backed build refuses the endpoint in words) does not
      // turn a hide that works into an error message.
      await markInvisible({
        targetFid,
        viewerFid: user.fid,
        block: block ?? false,
      }).catch(() => undefined);

      if (block) {
        trackEvent(AnalyticsEvent.ClickBlock, {
          source,
        });
      } else {
        trackEvent(AnalyticsEvent.ClickMute, {
          source,
        });
      }
      onMute();
      toast({
        message: `${username} ${block ? 'blocked' : 'hidden'}${
          span.ms === undefined ? '' : ` ${span.label.toLowerCase()}`
        }`,
        type: 'success',
      });
    } catch (e) {
      trackError(e);
      toast({
        message: `Failed to ${block ? 'block' : 'hide'} ${username}`,
        type: 'error',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onClose={onCancel} className="relative z-50" static>
      <DialogBackdrop />
      <DialogPanelContainer>
        <Dialog.Panel className="w-full max-w-[387px] rounded-lg border p-4 bg-app border-default">
          <Dialog.Title className="mb-4 flex items-center text-xl font-medium text-default">
            {block ? 'Block' : 'Hide'} {username}?
          </Dialog.Title>
          <Dialog.Description>
            {block ? (
              <>
                They won't appear in your feed and won't be able to reply, quote
                or mention you.{' '}
                <ExternalLink
                  href={getNotionLinkTarget({ to: 'user-blocking' })}
                  title="Learn more"
                  className="outline-hidden"
                >
                  Learn more
                </ExternalLink>
                .
              </>
            ) : (
              'Their posts stay hidden, but you can still look at their profile.'
            )}
          </Dialog.Description>
          <div
            className="mt-4 flex flex-wrap gap-[6px]"
            role="group"
            aria-label="How long"
          >
            {MUTE_SPANS.map((choice, index) => (
              <button
                key={choice.label}
                type="button"
                onClick={() => setSpanIndex(index)}
                disabled={submitting}
                aria-pressed={index === spanIndex}
                data-fiddy={`mute-duration-${index}`}
                className={cn(
                  'rounded-full border px-3 py-1 text-sm',
                  index === spanIndex
                    ? 'bg-overlay-faint border-default text-default'
                    : 'border-transparent text-faint hover:text-default',
                )}
              >
                {choice.label}
              </button>
            ))}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-[11px]">
            <DefaultButton
              onClick={onCancel}
              variant="secondary"
              disabled={submitting}
            >
              Cancel
            </DefaultButton>
            <DefaultButton
              onClick={mute}
              variant="danger"
              disabled={submitting}
            >
              {block ? 'Block' : 'Hide'}
            </DefaultButton>
          </div>
        </Dialog.Panel>
      </DialogPanelContainer>
    </Dialog>
  );
}
