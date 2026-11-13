import {
  articleCover,
  articleOpening,
  articlePartCount,
  articleTitle,
  fetchArticleChain,
  type ArticleChain,
  type NodeCastMessage,
} from 'farcaster-node-client';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { ArticleMarkdown } from '~/components/ArticleMarkdown';
import { useNodeSession } from '~/node/nodeSession';
import type { Profile } from '~/node/profiles';
import { colors, fonts, spacing } from '~/theme';
import { articleLabel, chainFailedCopy, incompleteCopy } from '~/utils/article';
import { timeAgo } from '~/utils/format';

type ArticleState =
  | { status: 'loading' }
  | { status: 'ready'; article: ArticleChain }
  | { status: 'failed'; article: ArticleChain | null; error: string };

/**
 * One article, read as one piece.
 *
 * The chain is read in a single pass from the same node the feed used, so a
 * mid-read failover cannot mix two indexes. When the read stops early the screen
 * shows the parts that arrived and says so; it never renders the article's first
 * cast as if it were the whole thing.
 *
 * Reading order is title → cover → body inside one scroll container, with
 * headings exposed as headings so VoiceOver can navigate them.
 */
export const ArticleScreen = ({
  root,
  profile,
  onClose,
}: {
  root: NodeCastMessage;
  profile?: Profile;
  onClose: () => void;
}) => {
  const session = useNodeSession();
  const [state, setState] = useState<ArticleState>({ status: 'loading' });

  const title = articleTitle(root);
  const declared = articlePartCount(root);
  const cover = articleCover(root);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void (async () => {
      try {
        const article = await fetchArticleChain({ node: session.client, root });
        if (!cancelled) {
          setState(
            article.error
              ? { status: 'failed', article, error: article.error }
              : { status: 'ready', article },
          );
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            status: 'failed',
            article: null,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session.client, root]);

  // The parts a reader can show: the root's opening, then every part that
  // arrived, in index order. With no chain read at all, the root is still a
  // cast worth showing — and the notice says the rest did not load.
  const shown = useMemo(() => {
    if (state.status === 'ready') {
      return state.article.loaded;
    }
    if (state.status === 'failed' && state.article) {
      return state.article.loaded;
    }
    return [root];
  }, [state, root]);

  const loadedCount = shown.length;
  const meta =
    state.status === 'failed'
      ? chainFailedCopy
      : state.status === 'ready' && !state.article.complete && declared > 0
        ? incompleteCopy(state.article.loaded.length, declared)
        : articleLabel(declared);

  const name = profile?.display ?? null;
  const handle = profile?.username ? `@${profile.username}` : null;

  return (
    <View style={styles.screen}>
      <View style={styles.topBar}>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Back to the feed"
          style={styles.back}
          hitSlop={spacing.sm}
        >
          <Text style={styles.backText}>‹ Feed</Text>
        </Pressable>
        <Text style={styles.meta} numberOfLines={1}>
          {meta}
        </Text>
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <Text accessibilityRole="header" style={styles.title}>
          {title}
        </Text>
        <Text style={styles.byline}>
          {name ?? handle ?? `fid ${root.fid}`}
          {name && handle ? ` ${handle}` : ''} · {timeAgo(root.timestampMs)}
        </Text>

        {cover ? (
          <Image
            source={{ uri: cover }}
            style={styles.cover}
            resizeMode="cover"
            accessible
            accessibilityLabel="Cover image"
          />
        ) : null}

        {/* The root's cover is the cast's single URL embed; it is already shown
            above, so it must not be placed again in the body. */}
        <ArticleMarkdown
          text={articleOpening(root)}
          embeds={cover ? [] : (root.castAdd?.embeds ?? [])}
        />

        {shown.slice(1).map((part) => (
          <View key={part.hash} style={styles.part}>
            <ArticleMarkdown
              text={part.castAdd?.text ?? ''}
              embeds={part.castAdd?.embeds ?? []}
            />
          </View>
        ))}

        {state.status === 'loading' ? (
          <View style={styles.notice}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.noticeText}>
              reading the rest of the article…
            </Text>
          </View>
        ) : null}

        {state.status === 'ready' && !state.article.complete && declared > 0 ? (
          <Text style={styles.incomplete}>
            {incompleteCopy(loadedCount, declared)}
          </Text>
        ) : null}

        {state.status === 'failed' ? (
          <Text style={styles.incomplete}>
            {chainFailedCopy} ({state.error})
          </Text>
        ) : null}

        <Text style={styles.foot}>
          {declared > 1
            ? `read from ${session.host} in one pass · ${loadedCount} of ${declared} parts`
            : `read from ${session.host}`}
        </Text>
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingBottom: spacing.sm,
  },
  back: {
    minHeight: 44,
    justifyContent: 'center',
    paddingRight: spacing.md,
  },
  backText: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: '700',
  },
  meta: {
    color: colors.inkDim,
    fontSize: 12,
    fontFamily: fonts.mono,
    flexShrink: 1,
    textAlign: 'right',
  },
  scroll: {
    paddingBottom: spacing.xl * 2,
    gap: spacing.md,
  },
  title: {
    color: colors.ink,
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '700',
  },
  byline: {
    color: colors.inkDim,
    fontSize: 13,
  },
  cover: {
    width: '100%',
    height: 200,
    borderRadius: 16,
    backgroundColor: colors.glass,
  },
  part: {
    marginTop: spacing.sm,
  },
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
  },
  noticeText: {
    color: colors.inkDim,
    fontSize: 13,
  },
  incomplete: {
    color: colors.warning,
    fontSize: 13,
    lineHeight: 19,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.hairline,
    paddingTop: spacing.md,
  },
  foot: {
    color: colors.inkFaint,
    fontSize: 12,
    lineHeight: 17,
    paddingTop: spacing.md,
  },
});
