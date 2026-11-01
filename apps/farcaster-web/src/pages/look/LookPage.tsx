/**
 * `/look/<id>` — a look someone handed to you.
 *
 * WHY IT IS A PUBLIC ROUTE. A look is meant to be handed on, so the link has to
 * work for whoever opens it: signed in, signed out, or a crawler. It sits
 * beside `/feed` and `/explore` (outside every sign-in gate) for the same
 * reason, and its name is reserved by the route table like theirs.
 *
 * WHAT A SIGNED-OUT VISITOR GETS. The look, drawn in its own colours, and "Put
 * this look on" — which works without an account, because a look is one
 * browser's set of variables and nothing about it needs a session. Wearing it is
 * how a stranger tries Fiddy's look before they have a Fiddy.
 *
 * WHAT A CRAWLER GETS. Nothing from this file: this is the app, and the app is
 * JavaScript. The same URL is answered by the per-page service this repo ships
 * (`server/unfurl/`), which serves this shell with the look's own title,
 * description and card (`server/unfurl/pages.mjs`, `lookPage`). The `PageMeta`
 * below is the browser's half of the same facts.
 */

import { FC, memo } from 'react';

import { Link } from '~/components/links/Link';
import { SharedLookCard } from '~/components/looks/SharedLookCard';
import { StandalonePage } from '~/components/page/StandalonePage';
import { useParams } from '~/hooks/navigation/useParams';

const LookPage: FC = memo(() => {
  const { id } = useParams('look');

  const canonical =
    typeof window === 'undefined'
      ? undefined
      : `${window.location.origin}/look/${id ?? ''}`;

  return (
    <StandalonePage
      meta={{
        title: 'A look for Fiddy',
        description:
          'A look someone made for Fiddy — its colours, corners and type. Put it on in one press, or make your own.',
        canonical,
        ogType: 'website',
      }}
    >
      <div className="flex flex-col gap-4 py-6" data-fiddy="look-page">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">A look for Fiddy</h1>
          <p className="text-sm text-faint">
            Colours, corners and type — the way someone made Fiddy look. Put it
            on and it stays until you change it.
          </p>
        </div>

        {id ? (
          <SharedLookCard id={id} />
        ) : (
          <p className="text-sm" data-fiddy="look-page-missing">
            That look link doesn&apos;t work any more.
          </p>
        )}

        <div className="flex flex-col gap-1 border-t pt-4 border-default">
          <p className="text-sm text-faint">Not your thing?</p>
          <Link
            to="homeFeed"
            params={{}}
            searchParams={{}}
            title="Open Fiddy"
            className="text-sm font-semibold underline"
          >
            <span data-fiddy="look-page-home">Open Fiddy</span>
          </Link>
        </div>
      </div>
    </StandalonePage>
  );
});

LookPage.displayName = 'LookPage';

export { LookPage };
