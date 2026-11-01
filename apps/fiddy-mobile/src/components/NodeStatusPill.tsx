import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useState } from 'react';

import { GlassCard } from '~/components/GlassCard';
import { SelfTestCard } from '~/dev/SelfTestCard';
import {
  describeSource,
  parseNodeUrl,
  type NodeSource,
} from '~/node/nodeConfig';
import { useNodeSession } from '~/node/nodeSession';
import { colors, fonts, radii, spacing } from '~/theme';
import { compactNumber } from '~/utils/format';

/**
 * "served by your node" — the one claim this app must never fake.
 *
 * The pill reports the node the app is reading *right now*: green only when
 * that node answered, amber while it is still being asked, red (with the host)
 * when it did not. Tapping opens the sheet, where the URL, where it came from,
 * and what the node says about itself are all visible.
 */
export const NodeStatusPill = () => {
  const session = useNodeSession();
  const [open, setOpen] = useState(false);

  const tone =
    session.status === 'ok'
      ? 'ok'
      : session.status === 'checking'
        ? 'checking'
        : 'down';

  const label =
    tone === 'ok'
      ? 'served by your node'
      : tone === 'checking'
        ? 'asking your node…'
        : 'your node is not answering';

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={[styles.pill, tone === 'ok' && styles.pillOk, tone === 'down' && styles.pillDown]}
        accessibilityRole="button"
        accessibilityLabel={`${label}. Tap for node details.`}
      >
        <View
          style={[
            styles.dot,
            tone === 'ok' && styles.dotOk,
            tone === 'checking' && styles.dotChecking,
            tone === 'down' && styles.dotDown,
          ]}
        />
        <Text style={styles.pillText} numberOfLines={1}>
          {label}
        </Text>
      </Pressable>
      <NodeSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
};

const NodeSheet = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const session = useNodeSession();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const info = session.health?.info;
  const totalMessages = info?.dbStats?.numMessages ?? 0;
  const maxHeight = info
    ? Math.max(...info.shardInfos.map((shard) => shard.maxHeight))
    : 0;
  const shards = info?.shardInfos.length ?? 0;

  const apply = () => {
    const parsed = parseNodeUrl(draft);
    if (!parsed) {
      setError('That does not look like a node URL (try http://host:3381).');
      return;
    }
    setError(null);
    session.useSessionNode(parsed);
    setDraft('');
    void session.refreshHealth();
  };

  return (
    <Modal
      visible={open}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.sheet}>
        <ScrollView contentContainerStyle={styles.sheetBody}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Your node</Text>
            <Pressable onPress={onClose} accessibilityRole="button">
              <Text style={styles.sheetClose}>Done</Text>
            </Pressable>
          </View>

          <GlassCard accent>
            <Text style={styles.cardLabel}>
              {session.status === 'ok'
                ? 'This build reads through your node'
                : session.status === 'checking'
                  ? 'Checking…'
                  : 'Not answering right now'}
            </Text>
            <Text style={styles.mono}>{session.url}</Text>
            <Text style={styles.quote}>{describeSource(session.source)}</Text>
            <View style={styles.factRow}>
              <Fact label="latency" value={session.health ? `${session.health.latencyMs}ms` : '—'} />
              <Fact label="version" value={info?.version ?? '—'} />
              <Fact label="shards" value={shards ? String(shards) : '—'} />
              <Fact
                label="messages"
                value={totalMessages ? compactNumber(totalMessages) : '—'}
              />
              <Fact label="max height" value={maxHeight ? compactNumber(maxHeight) : '—'} />
            </View>
            {session.health?.error ? (
              <Text style={styles.error}>{session.health.error}</Text>
            ) : null}
          </GlassCard>

          <GlassCard style={styles.switchCard}>
            <Text style={styles.cardLabel}>Read through a different node</Text>
            <Text style={styles.body}>
              A node on your own machine, a tunnel to a box of yours, or the
              public hub you keep for comparison.
            </Text>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder="http://127.0.0.1:3381"
              placeholderTextColor={colors.inkFaint}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              style={styles.input}
            />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <View style={styles.buttonRow}>
              <Pressable
                style={[styles.button, styles.buttonAccent]}
                onPress={apply}
                accessibilityRole="button"
              >
                <Text style={styles.buttonAccentText}>Read through it</Text>
              </Pressable>
              {session.isBuildNode ? null : (
                <Pressable
                  style={styles.button}
                  onPress={() => {
                    session.resetNode();
                    void session.refreshHealth();
                  }}
                  accessibilityRole="button"
                >
                  <Text style={styles.buttonText}>Back to build node</Text>
                </Pressable>
              )}
              <Pressable
                style={styles.button}
                onPress={() => void session.refreshHealth()}
                accessibilityRole="button"
              >
                <Text style={styles.buttonText}>Re-check</Text>
              </Pressable>
            </View>
            <Text style={styles.quote}>
              v1 keeps no preferences: a node you type here lasts until the app
              closes. Set EXPO_PUBLIC_FIDDY_NODE_URL and rebuild to make it stick.
            </Text>
          </GlassCard>

          <SelfTestCard />

          <GlassCard style={styles.switchCard}>
            <Text style={styles.cardLabel}>What this node never sees</Text>
            <Text style={styles.body}>
              No seed phrase, no custody key, no app key and no API key is in this
              app. v1 only reads: `GET /v1/*` against the URL above. Signing —
              which is the only thing that needs a key — is v2.
            </Text>
          </GlassCard>
        </ScrollView>
      </View>
    </Modal>
  );
};

const Fact = ({ label, value }: { label: string; value: string }) => (
  <View style={styles.fact}>
    <Text style={styles.factLabel}>{label}</Text>
    <Text style={styles.factValue}>{value}</Text>
  </View>
);

/** Compact tone label for anywhere that needs to state the node in a sentence. */
export const nodeSourceSentence = (source: NodeSource, host: string): string => {
  if (source === 'session') {
    return `reading the node you just entered (${host})`;
  }
  return `reading your node (${host})`;
};

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
    backgroundColor: colors.glass,
    maxWidth: '100%',
  },
  pillOk: {
    borderColor: colors.hairlineAccent,
  },
  pillDown: {
    borderColor: 'rgba(255,138,101,0.45)',
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.inkFaint,
  },
  dotOk: {
    backgroundColor: colors.accent,
  },
  dotChecking: {
    backgroundColor: colors.warning,
  },
  dotDown: {
    backgroundColor: colors.danger,
  },
  pillText: {
    color: colors.ink,
    fontSize: 12,
    letterSpacing: 0.2,
  },
  sheet: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  sheetBody: {
    padding: spacing.lg,
    gap: spacing.lg,
    paddingBottom: spacing.xl * 2,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sheetTitle: {
    color: colors.ink,
    fontSize: 22,
    fontWeight: '700',
  },
  sheetClose: {
    color: colors.accent,
    fontSize: 15,
  },
  cardLabel: {
    color: colors.ink,
    fontSize: 13,
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
  quote: {
    color: colors.inkFaint,
    fontSize: 12,
    lineHeight: 17,
    marginTop: spacing.sm,
  },
  body: {
    color: colors.inkDim,
    fontSize: 13,
    lineHeight: 19,
    marginTop: spacing.sm,
  },
  factRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    marginTop: spacing.md,
  },
  fact: {
    minWidth: 68,
  },
  factLabel: {
    color: colors.inkFaint,
    fontSize: 10,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  factValue: {
    color: colors.ink,
    fontSize: 14,
    fontFamily: fonts.mono,
    marginTop: 2,
  },
  switchCard: {
    marginTop: spacing.lg,
  },
  input: {
    marginTop: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
    borderRadius: radii.small,
    backgroundColor: 'rgba(0,0,0,0.25)',
    color: colors.ink,
    fontFamily: fonts.mono,
    fontSize: 13,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
  error: {
    color: colors.danger,
    fontSize: 12,
    marginTop: spacing.sm,
  },
  buttonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  button: {
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
  },
  buttonAccent: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  buttonText: {
    color: colors.ink,
    fontSize: 13,
  },
  buttonAccentText: {
    color: colors.onAccent,
    fontSize: 13,
    fontWeight: '700',
  },
});