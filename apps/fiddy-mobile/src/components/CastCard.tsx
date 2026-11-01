import type { NodeMessage } from 'farcaster-node-client';
import type { ReactNode } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import type { Profile } from '~/node/profiles';
import { colors, fonts, spacing } from '~/theme';
import { timeAgo } from '~/utils/format';

/** url | @mention | #channel — one pass, so a URL's #fragment is not recoloured. */
const TOKEN = /(https?:\/\/[^\s]+)|(@[a-zA-Z0-9._-]{1,64})|(#[a-zA-Z0-9][a-zA-Z0-9_-]{0,63})/g;

/** Cast text with tappable links; mentions and channels highlighted in place. */
export const CastText = ({ text }: { text: string }) => {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  TOKEN.lastIndex = 0;

  while ((match = TOKEN.exec(text)) !== null) {
    if (match.index > cursor) {
      nodes.push(<Text key={`t${cursor}`}>{text.slice(cursor, match.index)}</Text>);
    }
    const token = match[0];
    if (match[1]) {
      nodes.push(
        <Text
          key={`u${match.index}`}
          style={styles.link}
          onPress={() => void Linking.openURL(token)}
        >
          {token}
        </Text>,
      );
    } else {
      nodes.push(
        <Text key={`m${match.index}`} style={styles.mention}>
          {token}
        </Text>,
      );
    }
    cursor = match.index + token.length;
  }
  if (cursor < text.length) {
    nodes.push(<Text key={`t${cursor}`}>{text.slice(cursor)}</Text>);
  }

  return <Text style={styles.castText}>{nodes}</Text>;
};

export const CastCard = ({
  cast,
  profile,
}: {
  cast: NodeMessage;
  profile?: Profile;
}) => {
  const body = cast.castAdd;
  if (!body) {
    return null;
  }
  const name = profile?.display ?? null;
  const handle = profile?.username ? `@${profile.username}` : null;
  const embedCount = body.embeds?.length ?? 0;
  const repliesTo = body.parentCastId
    ? `replying to fid ${body.parentCastId.fid}`
    : body.parentUrl
      ? `in ${body.parentUrl.replace(/^https?:\/\/[^/]+\//, '')}`
      : null;

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.name}>{name ?? handle ?? `fid ${cast.fid}`}</Text>
        {name && handle ? <Text style={styles.handle}>{handle}</Text> : null}
        {!name && !handle ? <Text style={styles.handle}>fid {cast.fid}</Text> : null}
        <Text style={styles.time}>{timeAgo(cast.timestampMs)}</Text>
      </View>
      {repliesTo ? <Text style={styles.context}>{repliesTo}</Text> : null}
      <CastText text={body.text} />
      {embedCount > 0 ? (
        <Text style={styles.embedNote}>
          {embedCount === 1 ? '1 embed' : `${embedCount} embeds`} — not rendered in v1
        </Text>
      ) : null}
      <View style={styles.foot}>
        <Text style={styles.meta}>{body.castType}</Text>
        <Text style={styles.meta} numberOfLines={1}>
          {cast.hash.slice(0, 10)}…
        </Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    paddingVertical: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.hairline,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.sm,
    flexWrap: 'wrap',
  },
  name: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '700',
  },
  handle: {
    color: colors.inkDim,
    fontSize: 13,
  },
  time: {
    color: colors.inkFaint,
    fontSize: 12,
    fontFamily: fonts.mono,
  },
  context: {
    color: colors.inkFaint,
    fontSize: 12,
    marginTop: 2,
  },
  castText: {
    color: colors.ink,
    fontSize: 15,
    lineHeight: 22,
    marginTop: spacing.sm,
  },
  link: {
    color: colors.accent,
  },
  mention: {
    color: colors.accent,
    opacity: 0.85,
  },
  embedNote: {
    color: colors.inkFaint,
    fontSize: 12,
    marginTop: spacing.sm,
    fontStyle: 'italic',
  },
  foot: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  meta: {
    color: colors.inkFaint,
    fontSize: 10,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    fontFamily: fonts.mono,
  },
});