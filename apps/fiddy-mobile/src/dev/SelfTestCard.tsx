import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { GlassCard } from '~/components/GlassCard';
import { useNodeSession } from '~/node/nodeSession';
import { runSelfTest, type SelfTestCheck } from '~/dev/selfTest';
import { colors, fonts, spacing } from '~/theme';

/**
 * Runs the on-device checks and shows the raw result.
 *
 * This exists because "it bundles" is not "it runs": Hermes has no `Buffer`, no
 * `crypto` and a different text codec, and the only way to know whether reads
 * and message building work on the device is to do them on the device.
 */
export const SelfTestCard = () => {
  const session = useNodeSession();
  const [checks, setChecks] = useState<SelfTestCheck[] | null>(null);
  const [running, setRunning] = useState(false);

  const run = useCallback(async () => {
    setRunning(true);
    setChecks(null);
    try {
      setChecks(await runSelfTest(session.client, session.fid));
    } finally {
      setRunning(false);
    }
  }, [session.client, session.fid]);

  return (
    <GlassCard style={styles.card}>
      <Text style={styles.label}>On-device checks</Text>
      <Text style={styles.body}>
        Runs Buffer, text codec, Ed25519 signing and a full cast
        build→hash→sign→protobuf round-trip on this device, plus one real read
        from the node above. Nothing is submitted to the network and no key of
        yours is involved — the signing check uses a public test vector.
      </Text>
      <Pressable
        style={[styles.button, running && styles.buttonBusy]}
        onPress={() => void run()}
        disabled={running}
        accessibilityRole="button"
      >
        {running ? (
          <ActivityIndicator color={colors.onAccent} size="small" />
        ) : (
          <Text style={styles.buttonText}>
            {checks ? 'Run again' : 'Run checks on this device'}
          </Text>
        )}
      </Pressable>

      {checks
        ? checks.map((check) => (
            <View key={check.name} style={styles.row}>
              <Text style={[styles.mark, check.ok ? styles.pass : styles.fail]}>
                {check.ok ? 'PASS' : 'FAIL'}
              </Text>
              <View style={styles.rowBody}>
                <Text style={styles.rowName}>{check.name}</Text>
                <Text style={styles.rowDetail}>{check.detail}</Text>
              </View>
            </View>
          ))
        : null}
      {checks ? (
        <Text style={styles.summary}>
          {checks.every((check) => check.ok)
            ? `${checks.length}/${checks.length} checks passed on this device.`
            : `${checks.filter((check) => check.ok).length}/${checks.length} passed.`}
        </Text>
      ) : null}
    </GlassCard>
  );
};

const styles = StyleSheet.create({
  card: {
    marginTop: spacing.lg,
  },
  label: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  body: {
    color: colors.inkDim,
    fontSize: 13,
    lineHeight: 19,
    marginTop: spacing.sm,
  },
  button: {
    marginTop: spacing.md,
    backgroundColor: colors.accent,
    borderRadius: 999,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  buttonBusy: {
    opacity: 0.75,
  },
  buttonText: {
    color: colors.onAccent,
    fontSize: 14,
    fontWeight: '700',
  },
  row: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
    alignItems: 'flex-start',
  },
  mark: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.5,
    paddingTop: 1,
    width: 36,
  },
  pass: {
    color: colors.accent,
  },
  fail: {
    color: colors.danger,
  },
  rowBody: {
    flex: 1,
  },
  rowName: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '600',
  },
  rowDetail: {
    color: colors.inkDim,
    fontSize: 12,
    lineHeight: 17,
    fontFamily: fonts.mono,
    marginTop: 2,
  },
  summary: {
    color: colors.inkFaint,
    fontSize: 12,
    marginTop: spacing.md,
  },
});