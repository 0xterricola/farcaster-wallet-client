import { ApiCastFeedIncludeReason } from 'farcaster-client-data';
import { CastComposerEmbeds } from 'farcaster-client-hooks';

import { ApiCastWithContext } from '~/types';

export type CastProps = {
  castWithContext: ApiCastWithContext;
  castOpenIncludeReason?: ApiCastFeedIncludeReason['type'];
  isAdminGatedFeedCast?: boolean;
  /**
   * Draw this cast for someone who is only reading.
   *
   * A public surface (the browse window at `/feed` and `/explore`) shows real
   * casts to a visitor with no account. Every write affordance in the row
   * (reply, recast, like) needs an account, so in this mode the row is the
   * counts as plain text plus Share, which needs nothing, and the surface says
   * what signing in would add. Off by default: the rest of the app keeps its
   * buttons.
   */
  readOnly?: boolean;
};

export type CastDraftKeyParams = {
  parentHash: string | undefined;
};

export type CastDraft = {
  savedAt: number;
  text: string;
  embeds: CastComposerEmbeds;
  channelKey?: string;
};

export type CastDrafts = Record<string, CastDraft | undefined>;
