import { Image, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { GlassCard } from '~/components/GlassCard';
import { useNodeSession } from '~/node/nodeSession';
import { colors, fonts, spacing } from '~/theme';

/** The one URL in this app that leaves the app. */
export const HATCH_URL = 'https://fiddy.fun/start';

const SHIPPED = [
  {
    title: 'Reads your network through your node',
    body: 'Feed tab: your follow graph, their casts, merged locally. No indexer, no API key.',
  },
  {
    title: 'Honest about where the data came from',
    body: 'The pill names the node that answered. If it stops answering, the app says so instead of showing you a stranger’s cache.',
  },
  {
    title: 'Nothing to lose',
    body: 'No seed phrase, no custody key, no app key in the build. v1 cannot sign, so it cannot leak.',
  },
];

const SOON = [
  {
    tag: 'soon',
    title: 'Hatch your Fiddy',
    body: 'An agent bound to your FID that runs on the node you already pay for — schedules, drafts, replies, all signed with an app key you authorize (gaslessly).',
  },
  {
    tag: 'soon',
    title: 'Post, react, follow',
    body: 'Writes go through the same node with a gasless app key — no Optimism transaction, no seed phrase on this device.',
  },
  {
    tag: 'soon',
    title: 'Find your FID for you',
    body: 'v1 asks you to type it. Once hatching exists, the key you authorized already names it.',
  },
  {
    tag: 'soon',
    title: 'Android and desktop',
    body: 'Same shell, same node client. iOS first because it is the device in your hand.',
  },
];

/**
 * The Agent tab, v1: the NOT-HATCHED surface.
 *
 * It states what this build does and does not do, and sends the one action that
 * is real (hatching, on the web) out to the system browser — never into an
 * in-app webview, so the page it opens cannot see this app's session.
 */
export const AgentScreen = () => {
  const session = useNodeSession();

  const hatch = async () => {
    const supported = await Linking.canOpenURL(HATCH_URL);
    if (supported) {
      await Linking.openURL(HATCH_URL);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <GlassCard accent style={styles.hero}>
        <View style={styles.tagRow}>
          <View style={styles.tag}>
            <Text style={styles.tagText}>NOT HATCHED</Text>
          </View>
          <Text style={styles.tagHint}>this device</Text>
        </View>
        <Image
          source={require('../../assets/fiddy-mark.png')}
          style={styles.mark}
          resizeMode="contain"
        />
        <Text style={styles.heroTitle}>No Fiddy has hatched here yet.</Text>
        <Text style={styles.heroBody}>
          A Fiddy is not a tab and not a bot in a cloud you do not control. It is
          the thing that runs on your own node — reading your network, and acting
          for you with keys you authorize and can revoke.
        </Text>
        <Pressable
          style={styles.cta}
          onPress={() => void hatch()}
          accessibilityRole="link"
          accessibilityLabel="Hatch your Fiddy — opens fiddy.fun in your browser"
        >
          <Text style={styles.ctaText}>Hatch your Fiddy</Text>
        </Pressable>
        <Text style={styles.ctaHint}>
          opens fiddy.fun/start in your browser — this app's session is not shared
          with the page
        </Text>
      </GlassCard>

      <GlassCard style={styles.nodeCard}>
        <Text style={styles.cardLabel}>Runs against</Text>
        <Text style={styles.mono}>{session.url}</Text>
        <Text style={styles.cardBody}>
          {session.status === 'ok'
            ? `Answering in ${session.health?.latencyMs ?? '?'}ms · version ${
                session.health?.info?.version ?? '—'
              } · ${session.health?.info?.shardInfos.length ?? 0} shards`
            : session.status === 'checking'
              ? 'Asking…'
              : `Not answering: ${session.health?.error ?? 'no response'}`}
        </Text>
      </GlassCard>

      <Text style={styles.sectionTitle}>What v1 already does</Text>
      {SHIPPED.map((item) => (
        <GlassCard key={item.title} style={styles.item}>
          <Text style={styles.itemTitle}>{item.title}</Text>
          <Text style={styles.itemBody}>{item.body}</Text>
        </GlassCard>
      ))}

      <Text style={styles.sectionTitle}>What is not here yet</Text>
      {SOON.map((item) => (
        <GlassCard key={item.title} style={styles.item}>
          <View style={styles.soonHead}>
            <View style={styles.soonTag}>
              <Text style={styles.soonTagText}>{item.tag}</Text>
            </View>
            <Text style={styles.itemTitle}>{item.title}</Text>
          </View>
          <Text style={styles.itemBody}>{item.body}</Text>
        </GlassCard>
      ))}

      <Text style={styles.foot}>
        fiddy.fun · your node, your network, your agent
      </Text>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  scroll: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xl * 2,
    gap: spacing.md,
  },
  hero: {
    marginTop: spacing.md,
    alignItems: 'flex-start',
  },
  tagRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  tag: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairlineAccent,
    backgroundColor: colors.accentSoft,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: 999,
  },
  tagText: {
    color: colors.accent,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
  },
  tagHint: {
    color: colors.inkFaint,
    fontSize: 11,
  },
  mark: {
    width: 84,
    height: 84,
    marginTop: spacing.lg,
  },
  heroTitle: {
    color: colors.ink,
    fontSize: 24,
    fontWeight: '700',
    marginTop: spacing.md,
    lineHeight: 30,
  },
  heroBody: {
    color: colors.inkDim,
    fontSize: 14,
    lineHeight: 21,
    marginTop: spacing.sm,
  },
  cta: {
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.xl,
    paddingVertical: 14,
    borderRadius: 999,
    marginTop: spacing.lg,
  },
  ctaText: {
    color: colors.onAccent,
    fontSize: 15,
    fontWeight: '700',
  },
  ctaHint: {
    color: colors.inkFaint,
    fontSize: 11,
    marginTop: spacing.sm,
    lineHeight: 16,
  },
  nodeCard: {
    marginTop: spacing.md,
  },
  cardLabel: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  mono: {
    color: colors.accent,
    fontFamily: fonts.mono,
    fontSize: 13,
    marginTop: spacing.sm,
  },
  cardBody: {
    color: colors.inkDim,
    fontSize: 13,
    lineHeight: 19,
    marginTop: spacing.sm,
  },
  sectionTitle: {
    color: colors.inkFaint,
    fontSize: 12,
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginTop: spacing.lg,
    marginBottom: spacing.xs,
  },
  item: {
    marginBottom: spacing.sm,
  },
  soonHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  soonTag: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
  },
  soonTagText: {
    color: colors.inkFaint,
    fontSize: 9,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  itemTitle: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '600',
  },
  itemBody: {
    color: colors.inkDim,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 4,
  },
  foot: {
    color: colors.inkFaint,
    fontSize: 11,
    textAlign: 'center',
    marginTop: spacing.xl,
  },
});