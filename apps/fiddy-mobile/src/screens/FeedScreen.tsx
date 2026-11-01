import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { CastCard } from '~/components/CastCard';
import { FidSheet } from '~/components/FidSheet';
import { GlassCard } from '~/components/GlassCard';
import { useHomeFeed, useNodeSession } from '~/node/nodeSession';
import { useProfiles } from '~/node/profiles';
import { colors, fonts, spacing } from '~/theme';

const AUTHORS_CAP = 24;

/** The Feed tab: your follow graph, their casts, read through your own node. */
export const FeedScreen = () => {
  const session = useNodeSession();
  const feed = useHomeFeed(session);
  const [fidSheetOpen, setFidSheetOpen] = useState(false);

  const authorFids = useMemo(() => {
    const unique = new Set<number>();
    for (const cast of feed.casts) {
      unique.add(cast.fid);
      if (unique.size >= AUTHORS_CAP) {
        break;
      }
    }
    return [...unique];
  }, [feed.casts]);

  const profiles = useProfiles(session.client, authorFids);

  return (
    <View style={styles.screen}>
      <FlatList
        data={feed.casts}
        keyExtractor={(item) => `${item.fid}:${item.hash}`}
        renderItem={({ item }) => (
          <CastCard cast={item} profile={profiles.get(item.fid)} />
        )}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={feed.status === 'loading'}
            onRefresh={() => {
              feed.reload();
              void session.refreshHealth();
            }}
            tintColor={colors.accent}
          />
        }
        ListHeaderComponent={
          <View style={styles.header}>
            <GlassCard accent>
              <View style={styles.headerRow}>
                <Text style={styles.headerLabel}>
                  {feed.status === 'loading' && feed.following.length > 0
                    ? 'reading your follow graph'
                    : feed.status === 'loading'
                      ? 'reading your node'
                      : feed.status === 'error'
                        ? 'read failed'
                        : 'your feed'}
                </Text>
                <Pressable
                  onPress={() => setFidSheetOpen(true)}
                  accessibilityRole="button"
                  style={styles.fidButton}
                >
                  <Text style={styles.fidButtonText}>
                    {session.fid ? `fid ${session.fid}` : 'choose FID'}
                  </Text>
                </Pressable>
              </View>
              <Text style={styles.headerMeta}>
                {session.status === 'down'
                  ? `${session.host} is not answering — nothing below is cached`
                  : feed.status === 'loading' && feed.following.length > 0
                    ? `${feed.following.length} follows read from ${session.host}`
                    : `${feed.casts.length} casts from ${session.host}`}
              </Text>
            </GlassCard>
          </View>
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            {feed.status === 'loading' ? (
              <>
                <ActivityIndicator color={colors.accent} />
                <Text style={styles.emptyTitle}>Asking your node…</Text>
                <Text style={styles.emptyBody}>
                  No indexer is involved: the app reads your follow graph and
                  merges each account’s casts on the Farcaster timestamp. On a
                  cold start that is a few hundred reads.
                </Text>
              </>
            ) : feed.status === 'error' ? (
              <>
                <Text style={styles.emptyTitle}>Your node did not answer</Text>
                <Text style={styles.emptyBody}>{feed.error}</Text>
                <Text style={styles.emptyBody}>
                  Tap the pill at the top for the node the app is pointed at, or
                  pull down to retry.
                </Text>
              </>
            ) : !session.fid ? (
              <>
                <Text style={styles.emptyTitle}>No FID chosen</Text>
                <Text style={styles.emptyBody}>
                  A read node has no home feed — it has your follow graph. Pick
                  the FID whose network you want to read.
                </Text>
                <Pressable
                  style={styles.cta}
                  onPress={() => setFidSheetOpen(true)}
                  accessibilityRole="button"
                >
                  <Text style={styles.ctaText}>Choose a FID</Text>
                </Pressable>
              </>
            ) : (
              <>
                <Text style={styles.emptyTitle}>Nothing to show</Text>
                <Text style={styles.emptyBody}>
                  This FID follows nobody this node can see, or its follows have
                  not cast recently.
                </Text>
              </>
            )}
          </View>
        }
        ListFooterComponent={
          feed.casts.length > 0 ? (
            <Text style={styles.footer}>
              read-only in v1 · posting with a gasless app key is v2 · no key of
              any kind is in this build
            </Text>
          ) : null
        }
      />
      <FidSheet
        open={fidSheetOpen}
        fid={session.fid}
        onClose={() => setFidSheetOpen(false)}
        onSubmit={(fid) => {
          session.setFid(fid);
          setFidSheetOpen(false);
        }}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  list: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xl * 2,
  },
  header: {
    paddingTop: spacing.md,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  headerLabel: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  fidButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairlineAccent,
    backgroundColor: colors.accentSoft,
  },
  fidButtonText: {
    color: colors.accent,
    fontSize: 12,
    fontFamily: fonts.mono,
  },
  headerMeta: {
    color: colors.inkDim,
    fontSize: 12,
    marginTop: spacing.sm,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
  },
  empty: {
    paddingTop: spacing.xl,
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  emptyTitle: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: '700',
  },
  emptyBody: {
    color: colors.inkDim,
    fontSize: 13,
    lineHeight: 19,
  },
  cta: {
    marginTop: spacing.md,
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.lg,
    paddingVertical: 12,
    borderRadius: 999,
  },
  ctaText: {
    color: colors.onAccent,
    fontWeight: '700',
    fontSize: 14,
  },
  footer: {
    color: colors.inkFaint,
    fontSize: 12,
    lineHeight: 17,
    paddingTop: spacing.lg,
  },
});