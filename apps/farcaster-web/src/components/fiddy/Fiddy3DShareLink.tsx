/**
 * Link to open the Fiddy 3D share page for a user.
 * Shows on own profile when user has opted in to Fiddy 3D.
 */

import { FC, memo } from 'react';

import { ExternalLink } from '~/components/links/ExternalLink';

export const FIDDY_3D_SHARE_BASE = 'https://fiddy.fun/3d/share';

interface Fiddy3DShareLinkProps {
  /** The FID to link to */
  fid: number;
}

/**
 * Link to open the Fiddy 3D share viewer for a specific FID.
 * Points to https://fiddy.fun/3d/share/<fid>
 */
const Fiddy3DShareLink: FC<Fiddy3DShareLinkProps> = memo(({ fid }) => {
  return (
    <ExternalLink
      href={`${FIDDY_3D_SHARE_BASE}/${fid}`}
      title="Open 3D figure"
      className="ml-2 text-xs text-purple-600 hover:underline"
    >
      Open 3D figure
    </ExternalLink>
  );
});

Fiddy3DShareLink.displayName = 'Fiddy3DShareLink';

export { Fiddy3DShareLink };
export type { Fiddy3DShareLinkProps };
