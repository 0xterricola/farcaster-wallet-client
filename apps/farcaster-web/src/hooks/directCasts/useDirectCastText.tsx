import classNames from 'classnames';
import {
  ApiDirectCastConversationInfoV3,
  ApiDirectCastInboxConversationInfoV3,
  ApiDirectCastMessageV3,
  getTokenEmbedUrl,
} from 'farcaster-client-data';
import {
  assertDirectCastMessageTypeOrThrow,
  resolveUsername,
} from 'farcaster-client-hooks';
import React from 'react';

import { LinkToProfileWithSummaryTooltip } from '~/components/links/LinkToProfileWithSummaryTooltip';
import { LinkifiedText } from '~/components/text/LinkifiedText';
import { useLinkify } from '~/contexts/LinkifyProvider';
import { useCurrentUser } from '~/hooks/data/useCurrentUser';
import { useShouldLabelDirectCastAsFromYou } from '~/hooks/directCasts/useShouldLabelDirectCastAsFromYou';
import { clientEmbedKindResolver } from '~/snapchain/nodeApi/embedKinds';
import { splitDirectCastMessageImageTokens } from '~/utils/directCastImageTokens';

const matchedSearchTermsTag = 'fc_highlight';

const useDirectCastText = ({
  conversation,
  directCast,
  applyInboxStyles,
  parseMatchedSearchTermsFromLastMessage,
}: {
  conversation:
    | ApiDirectCastConversationInfoV3
    | ApiDirectCastInboxConversationInfoV3;
  directCast: ApiDirectCastMessageV3 | undefined;
  applyInboxStyles: boolean;
  parseMatchedSearchTermsFromLastMessage?: boolean | undefined;
}): { text: string | React.ReactNode; imageUrls: string[] } => {
  const { fid: currentUserFid } = useCurrentUser();

  const shouldLabelDirectCastAsFromYou = useShouldLabelDirectCastAsFromYou({
    directCast,
  });
  const { defaultLinkifyInstance } = useLinkify();

  const lastReadAt = React.useMemo(() => {
    return conversation.viewerContext.lastReadAt;
  }, [conversation]);

  const shouldDisplayReactionSummary =
    applyInboxStyles &&
    typeof conversation.viewerContext.unreadReactionMessage !== 'undefined' &&
    conversation.viewerContext.unreadReactionMessage.timestamp > lastReadAt;

  const shouldPrefixYou =
    shouldLabelDirectCastAsFromYou &&
    applyInboxStyles &&
    !shouldDisplayReactionSummary;

  const shouldPrefixGroupParticipant =
    applyInboxStyles &&
    !shouldPrefixYou &&
    conversation.isGroup &&
    !shouldDisplayReactionSummary;

  const affectedUser = React.useMemo(() => {
    return directCast?.actionTargetUserContext;
  }, [directCast?.actionTargetUserContext]);

  const affectedUserUsername = React.useMemo(() => {
    return resolveUsername({
      username: affectedUser?.username,
      fid: affectedUser?.fid,
    }).replace('@', '');
  }, [affectedUser?.username, affectedUser?.fid]);

  const reactor = React.useMemo(() => {
    return {
      fid: conversation.viewerContext.unreadReactionMessage?.fid ?? 0,
      username:
        conversation.viewerContext.unreadReactionMessage?.username ?? '',
    };
  }, [conversation.viewerContext.unreadReactionMessage]);
  const sender = React.useMemo(() => directCast?.senderContext, [directCast]);

  const text = React.useMemo(() => {
    // Search results have matched terms surrounded by <fc_highlight> tags
    if (parseMatchedSearchTermsFromLastMessage && directCast) {
      const tag = matchedSearchTermsTag;
      const { message } = directCast;

      // OpenSearch sometimes returns snippets that span multiple lines
      // We want to select the first line with a matched term
      const lines = message.trim().split('\n');
      const matchedLine = lines.find((line) => line.includes(`<${tag}>`));
      const lineToShow = matchedLine || lines[0] || '';

      // We want to bold the matched terms
      const parts = lineToShow.split(new RegExp(`(<${tag}>.*?</${tag}>)`, 'g'));
      return parts.map((part, index) => {
        if (!part.startsWith(`<${tag}>`) || !part.endsWith(`</${tag}>`)) {
          return <span key={index}>{part}</span>;
        }
        const content = part.replace(new RegExp(`</?${tag}>`, 'g'), '');
        return (
          <span key={index} className="font-semibold text-default">
            {content}
          </span>
        );
      });
    }

    if (
      shouldDisplayReactionSummary &&
      typeof conversation.viewerContext.unreadReactionMessage !== 'undefined'
    ) {
      const { reaction: reactionText, reactedMessage } =
        conversation.viewerContext.unreadReactionMessage;

      if (typeof reactor !== 'undefined') {
        const reactorDisplayName =
          reactor.fid === currentUserFid ? 'You' : reactor.username;
        const suffix =
          typeof reactedMessage !== 'undefined' ? `to "${reactedMessage}"` : '';

        return `${reactorDisplayName} reacted with ${reactionText} ${suffix}`;
      }
    }

    if (directCast) {
      return directCast.message;
    }

    return 'Unable to render direct cast';
  }, [
    parseMatchedSearchTermsFromLastMessage,
    reactor,
    conversation.viewerContext.unreadReactionMessage,
    currentUserFid,
    directCast,
    shouldDisplayReactionSummary,
  ]);

  const tokenEmbeds = React.useMemo(() => {
    if (!directCast) {
      return [];
    }

    const metadata = directCast.metadata;

    if (
      typeof metadata === 'undefined' ||
      typeof metadata.urls === 'undefined'
    ) {
      return [];
    }

    const tokenMatchedEmbedLinks = metadata.urls
      .map((o) => {
        if (typeof o.tokenV2 !== 'undefined') {
          return getTokenEmbedUrl(o.tokenV2);
        }

        return undefined;
      })
      .filter((link) => typeof link !== 'undefined');

    return tokenMatchedEmbedLinks;
  }, [directCast]);

  const cleanedUpText = React.useMemo(() => {
    if (!directCast) {
      return '';
    }

    const message = directCast.message;

    const mediaEmbeds = directCast.metadata?.medias;

    const videoEmbeds = directCast.metadata?.videos;

    if (
      typeof mediaEmbeds !== 'undefined' &&
      mediaEmbeds.length !== 0 &&
      message.startsWith(mediaEmbeds[0].staticRaster)
    ) {
      return message.replace(mediaEmbeds[0].staticRaster, '').trimStart();
    }

    if (
      typeof videoEmbeds !== 'undefined' &&
      videoEmbeds.length !== 0 &&
      message.startsWith(videoEmbeds[0].sourceUrl)
    ) {
      return message.replace(videoEmbeds[0].sourceUrl, '').trimStart();
    }

    if (tokenEmbeds.length !== 0 && message.startsWith(tokenEmbeds[0])) {
      return message.replace(tokenEmbeds[0], '').trimStart();
    }

    if (
      typeof directCast.payload !== 'undefined' &&
      directCast.payload.type === 'rich_announcement'
    ) {
      return directCast.payload.payload.body;
    }

    return message;
  }, [directCast, tokenEmbeds]);

  /**
   * The one resolver that answers "what IS this URL" for a rendered message —
   * built on first use, shared with every other message on the page, cached per
   * session and (where storage allows) beyond it. See its own note in
   * `~/snapchain/nodeApi/embedKinds`.
   */
  const embedKinds = React.useMemo(() => clientEmbedKindResolver(), []);

  /** URLs this bubble already draws as an embed: never pulled out and drawn twice. */
  const embeddedMediaUrls = React.useMemo(() => {
    const urls = new Set<string>();
    for (const media of directCast?.metadata?.medias ?? []) {
      urls.add(media.staticRaster);
    }
    for (const video of directCast?.metadata?.videos ?? []) {
      urls.add(video.sourceUrl);
    }
    return urls;
  }, [directCast?.metadata?.medias, directCast?.metadata?.videos]);

  /**
   * The classifier's answers live outside React, so a probe that lands has
   * nothing to tell a renderer about. This is that signal: it changes when this
   * message asked and learned something, which is what makes the split below
   * run again and the pictures appear.
   */
  const [embedKindVersion, setEmbedKindVersion] = React.useState(0);

  const imageParts = React.useMemo(
    () =>
      splitDirectCastMessageImageTokens({
        message: cleanedUpText,
        skip: embeddedMediaUrls,
        kindOf: (url) => embedKinds.kindOf(url),
      }),
    // `embedKindVersion` is deliberate and is not an input: the classifier's
    // answers live outside React, so this is the only way it can tell a render
    // that it learned something. Nothing else in the list can stand in for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cleanedUpText, embedKinds, embeddedMediaUrls, embedKindVersion],
  );

  const unknownImageCandidates = imageParts.unknownImageCandidates;
  /** A list that only changes when the tokens themselves change, so the ask runs once. */
  const unknownImageCandidateKey = unknownImageCandidates.join('\n');

  React.useEffect(() => {
    // A DM LIST asks nothing. Its previews are drawn for conversations the
    // reader has not opened, and a read from one would tell a stranger's host
    // that this reader is scrolling their inbox — a cost with nothing to show
    // for it. A preview answers from what is already known.
    if (applyInboxStyles) {
      return;
    }
    if (unknownImageCandidateKey === '') {
      return;
    }

    const urls = unknownImageCandidateKey.split('\n');
    let cancelled = false;

    const ask = async (): Promise<void> => {
      // Bounded by `classify`'s own deadline: whatever answered in time is drawn
      // now, and the probes that outlasted it are drawn when they land.
      await embedKinds.classify(urls);
      if (cancelled) {
        return;
      }
      setEmbedKindVersion((previous) => previous + 1);

      await embedKinds.settle();
      if (!cancelled) {
        setEmbedKindVersion((previous) => previous + 1);
      }
    };

    void ask();

    return () => {
      cancelled = true;
    };
  }, [applyInboxStyles, embedKinds, unknownImageCandidateKey]);

  const renderedText = React.useMemo(() => {
    if (!directCast) {
      // We were showing "No messages, yet" here but there is some odd corner case
      // resulting in it showing even though there are messages. Until we catch that
      // case converting this to just returning no text.
      return { text: '' };
    }
    const item = directCast;

    try {
      assertDirectCastMessageTypeOrThrow({ type: directCast.type });
    } catch {
      return {
        text: 'Message is not supported — please update Farcaster',
      };
    }

    if (typeof sender === 'undefined') {
      return { text: '' };
    }

    const actionTakenByAffectedUser =
      typeof affectedUser !== 'undefined' && affectedUser.fid === sender.fid;

    const senderUsername =
      sender.fid === currentUserFid
        ? 'You'
        : resolveUsername({
            username: sender.username,
            fid: sender.fid,
          }).replace('@', '');

    const imageUrls = imageParts.imageUrls;

    /** Whether this message carries a media embed (which the bubble draws itself). */
    const hasMetadataImage = (directCast.metadata?.medias?.length ?? 0) > 0;
    const hasMetadataVideo = (directCast.metadata?.videos?.length ?? 0) > 0;

    /**
     * A message that is only pictures: no text is left to preview, so the list
     * says what it is instead. This replaces the one hard-coded shape the inbox
     * used to know (`message.startsWith(imagedelivery…)`) with the same
     * sentence for any host — and for two pictures, not just one.
     */
    if (
      applyInboxStyles &&
      imageParts.text.trim() === '' &&
      (imageUrls.length > 0 || hasMetadataImage || hasMetadataVideo)
    ) {
      return {
        text: `${senderUsername} shared ${
          imageUrls.length > 1 ? 'images' : 'an image'
        }`,
      };
    }

    if (item.type === 'pin_message') {
      const text = `${senderUsername} pinned a message`;

      return { text };
    }
    if (
      item.type === 'group_membership_addition' &&
      typeof affectedUser !== 'undefined'
    ) {
      if (applyInboxStyles) {
        const text = !actionTakenByAffectedUser
          ? `${senderUsername} added ${affectedUserUsername}`
          : `${affectedUserUsername} joined`;

        return { text };
      }

      if (!actionTakenByAffectedUser) {
        return {
          text: (
            <span className="flex flex-row gap-x-1">
              <span>{`${senderUsername} added`}</span>
              <LinkToProfileWithSummaryTooltip
                user={affectedUser}
                title={affectedUserUsername}
                className="relative hover:underline"
              >
                {affectedUserUsername}
              </LinkToProfileWithSummaryTooltip>
            </span>
          ),
        };
      }

      return {
        text: (
          <span className="flex flex-row gap-x-1">
            <LinkToProfileWithSummaryTooltip
              user={affectedUser}
              title={affectedUserUsername}
              className="relative hover:underline"
            >
              {affectedUserUsername}
            </LinkToProfileWithSummaryTooltip>
            <span>{'joined via a link'}</span>
          </span>
        ),
      };
    }
    if (
      item.type === 'group_membership_removal' &&
      typeof affectedUser !== 'undefined'
    ) {
      if (applyInboxStyles) {
        const text = !actionTakenByAffectedUser
          ? `${senderUsername} removed ${affectedUserUsername}`
          : `${affectedUserUsername} left`;

        return { text };
      }
      if (!actionTakenByAffectedUser) {
        return {
          text: (
            <span className="flex flex-row gap-x-1">
              <span>{`${senderUsername} removed`}</span>
              <LinkToProfileWithSummaryTooltip
                user={affectedUser}
                title={affectedUserUsername}
                className="relative hover:underline"
              >
                {affectedUserUsername}
              </LinkToProfileWithSummaryTooltip>
            </span>
          ),
        };
      }

      return {
        text: (
          <span className="flex flex-row gap-x-1">
            <LinkToProfileWithSummaryTooltip
              user={affectedUser}
              title={affectedUserUsername}
              className="relative hover:underline"
            >
              {affectedUserUsername}
            </LinkToProfileWithSummaryTooltip>
            <span>{'left'}</span>
          </span>
        ),
      };
    }
    if (item.type === 'group_name_change') {
      return {
        text: `${senderUsername} changed group name to ${item.message}`,
      };
    }

    if (item.type === 'message_ttl_change') {
      if (item.message === 'Infinity') {
        return {
          text: `${senderUsername} set messages to never auto-delete`,
        };
      }
      const label = item.message === '1' ? 'day' : 'days';
      return {
        text: `${senderUsername} set messages to auto-delete in ${item.message} ${label}`,
      };
    }

    if (shouldPrefixYou) {
      return {
        text: (
          <>
            <span className="text-muted" style={{ fontWeight: 500 }}>
              You:{' '}
            </span>
            {text}
          </>
        ),
      };
    }

    if (shouldPrefixGroupParticipant && typeof sender !== 'undefined') {
      return {
        text: (
          <>
            <span className="text-muted" style={{ fontWeight: 500 }}>
              {sender.username}:{' '}
            </span>
            {text}
          </>
        ),
      };
    }

    if (applyInboxStyles) {
      // The list shows what the message says, with the picture links taken out
      // (they are not drawn in a list). When a picture link was the whole
      // message, there is nothing left to show: the sentence above said so.
      return { text: imageParts.text !== '' ? imageParts.text : text };
    }

    const matches = defaultLinkifyInstance.match(imageParts.text);
    let mentions: string[];
    if (directCast.viewerContext?.isOptimistic) {
      mentions =
        matches
          ?.filter((m) => m.schema === '@')
          .map((m) => m.url.split('/')[3]) ?? [];
    } else {
      mentions = (directCast.mentions ?? [])
        .map((m) => m.user.username)
        .filter((username): username is string => username !== undefined);
    }

    return {
      text: (
        <LinkifiedText
          content={imageParts.text}
          mentions={mentions}
          channelMentions={matches
            ?.filter((m) => m.schema === '/')
            .map((m) => {
              return {
                key: m.url.split('/')[3],
                name: m.url.split('/')[3],
              };
            })}
          tokenMentions={undefined}
          tokenMentionsV2={undefined}
          key="direct-cast-text"
          linkClassNameOverrides={classNames(
            '!text-direct-casts-link underline',
          )}
          skipURLTruncates={true}
        />
      ),
    };
  }, [
    affectedUser,
    affectedUserUsername,
    applyInboxStyles,
    currentUserFid,
    defaultLinkifyInstance,
    directCast,
    imageParts,
    sender,
    shouldPrefixGroupParticipant,
    shouldPrefixYou,
    text,
  ]);

  return React.useMemo(
    () => ({
      text: renderedText.text,
      // Pictures are drawn by the conversation view, not by a list preview.
      imageUrls: applyInboxStyles ? [] : imageParts.imageUrls,
    }),
    [applyInboxStyles, imageParts.imageUrls, renderedText],
  );
};

export { useDirectCastText };
