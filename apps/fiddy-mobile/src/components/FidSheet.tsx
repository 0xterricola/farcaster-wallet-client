import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useState } from 'react';

import { GlassCard } from '~/components/GlassCard';
import { colors, fonts, radii, spacing } from '~/theme';

/**
 * Whose network are we reading?
 *
 * A read node has no home feed: the client assembles one from *your* follow
 * graph, so the client needs to know which FID is you. v1 has no sign-in (and
 * no key material of any kind), so this is a one-field prompt rather than a
 * wallet — and the app says so instead of pretending.
 */
export const FidSheet = ({
  open,
  fid,
  onClose,
  onSubmit,
}: {
  open: boolean;
  fid: number;
  onClose: () => void;
  onSubmit: (fid: number) => void;
}) => {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const apply = () => {
    const parsed = Number.parseInt(draft.trim(), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError('A FID is a positive number (yours is at farcaster.xyz or in the app you use now).');
      return;
    }
    setError(null);
    setDraft('');
    onSubmit(parsed);
  };

  return (
    <Modal
      visible={open}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.sheet}>
        <View style={styles.header}>
          <Text style={styles.title}>Whose network?</Text>
          <Pressable onPress={onClose} accessibilityRole="button">
            <Text style={styles.close}>Done</Text>
          </Pressable>
        </View>
        <GlassCard accent>
          <Text style={styles.label}>Your FID</Text>
          <Text style={styles.body}>
            The feed is built from the follow graph of this FID, read from your
            own node. Right now it reads fid {fid || '—'} — v1 starts on a
            starter FID so the node read is visible before you choose, and one tap
            makes it yours.
          </Text>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="e.g. 3"
            placeholderTextColor={colors.inkFaint}
            keyboardType="number-pad"
            style={styles.input}
            autoFocus
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <View style={styles.row}>
            <Pressable
              style={[styles.button, styles.buttonAccent]}
              onPress={apply}
              accessibilityRole="button"
            >
              <Text style={styles.buttonAccentText}>Read this FID</Text>
            </Pressable>
            <Pressable style={styles.button} onPress={onClose} accessibilityRole="button">
              <Text style={styles.buttonText}>Cancel</Text>
            </Pressable>
          </View>
          <Text style={styles.quote}>
            [soon] v1 asks. v2 finds it for you: the wallet or app key you hatch
            with already names your FID, so this field disappears.
          </Text>
        </GlassCard>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  sheet: {
    flex: 1,
    backgroundColor: colors.bg,
    padding: spacing.lg,
    gap: spacing.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    color: colors.ink,
    fontSize: 22,
    fontWeight: '700',
  },
  close: {
    color: colors.accent,
    fontSize: 15,
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
  input: {
    marginTop: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
    borderRadius: radii.small,
    backgroundColor: 'rgba(0,0,0,0.25)',
    color: colors.ink,
    fontFamily: fonts.mono,
    fontSize: 16,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
  error: {
    color: colors.danger,
    fontSize: 12,
    marginTop: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  button: {
    paddingHorizontal: spacing.lg,
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
  quote: {
    color: colors.inkFaint,
    fontSize: 12,
    lineHeight: 17,
    marginTop: spacing.md,
  },
});