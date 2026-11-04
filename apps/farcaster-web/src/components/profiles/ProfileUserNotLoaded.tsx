import { FC, memo } from 'react';

import { BorderedMainContent } from '~/components/BorderedMainContent';
import { BackButton } from '~/components/forms/buttons/BackButton';
import { Page } from '~/components/page/Page';
import { PageHeader } from '~/components/page/PageHeader';
import { PageTitle } from '~/components/page/PageTitle';
import { NodeCannotAnswerPanel } from '~/components/snapchain/NodeCannotAnswerPanel';
import { PROFILE_LOOKUP_COPY } from '~/constants/profileLookup';
import { nodeCannotAnswer } from '~/snapchain/nodeApi/nodeCannotAnswer';
import { getErrorDescription } from '~/utils/errorUtils';

type ProfileUserNotLoadedProps = {
  username: string;
  error: Error;
  /** The one action that can change an outage answer: ask again. */
  onRetry: () => void;
};

/**
 * What a profile page shows when the user lookup failed for reasons that are
 * not "nobody goes by that name".
 *
 * The username fetcher rethrows every non-404 failure (quilcast 0.61.1,
 * backmeupplz/quilcast 27c1253, MIT — "a node that is down no longer says
 * your account doesn't exist"), and `useUserByUsernameProfile` hands that
 * error here instead of letting the page render "not found". Two shapes:
 *
 *   - the read seam's own refusal (501: this read is not on your node;
 *     502: the node did not answer) is shown in the seam's own words, the
 *     same panel the shell's regions use;
 *   - anything else gets the outage sentence: the reader's account is fine,
 *     the server is not, with a retry.
 */
const ProfileUserNotLoaded: FC<ProfileUserNotLoadedProps> = memo(
  ({ username, error, onRetry }) => {
    const refusal = nodeCannotAnswer(error);
    if (refusal) {
      return (
        <Page meta={{ title: `@${username}` }}>
          <BorderedMainContent>
            <PageHeader hideBorderBottom>
              <PageTitle>
                <BackButton />
              </PageTitle>
            </PageHeader>
            <div className="mt-4 p-4 pt-6">
              <NodeCannotAnswerPanel
                label={`@${username}’s profile`}
                reason={refusal.message}
                {...(refusal.retryable ? { onRetry } : {})}
              />
            </div>
          </BorderedMainContent>
        </Page>
      );
    }

    return (
      <Page meta={{ title: `@${username}` }}>
        <BorderedMainContent>
          <PageHeader hideBorderBottom>
            <PageTitle>
              <BackButton />
            </PageTitle>
          </PageHeader>
          <div className="mt-4 p-4 pt-6">
            <div className="fiddy-degrade" data-fiddy="profile-node-down">
              <p className="fiddy-degrade-title">
                {PROFILE_LOOKUP_COPY.nodeDownTitle}
              </p>
              <p className="fiddy-degrade-body">
                {PROFILE_LOOKUP_COPY.nodeDownBody}{' '}
                <span className="text-faint">{getErrorDescription(error)}</span>
              </p>
              <div className="fiddy-degrade-actions">
                <button
                  type="button"
                  className="fiddy-quiet-btn fiddy-quiet-btn-outline fiddy-degrade-btn"
                  onClick={onRetry}
                >
                  {PROFILE_LOOKUP_COPY.retry}
                </button>
              </div>
            </div>
          </div>
        </BorderedMainContent>
      </Page>
    );
  },
);

ProfileUserNotLoaded.displayName = 'ProfileUserNotLoaded';

export { ProfileUserNotLoaded };
