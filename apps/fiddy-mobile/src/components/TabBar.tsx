import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radii, spacing } from '~/theme';

export type TabKey = 'feed' | 'agent';

export const TABS: { key: TabKey; label: string }[] = [
  { key: 'feed', label: 'Feed' },
  { key: 'agent', label: 'Agent' },
];

export const TabBar = ({
  active,
  onChange,
}: {
  active: TabKey;
  onChange: (key: TabKey) => void;
}) => (
  <View style={styles.bar}>
    {TABS.map((tab) => {
      const selected = tab.key === active;
      return (
        <Pressable
          key={tab.key}
          onPress={() => onChange(tab.key)}
          accessibilityRole="tab"
          accessibilityState={{ selected }}
          style={[styles.tab, selected && styles.tabActive]}
        >
          <Text style={[styles.label, selected && styles.labelActive]}>{tab.label}</Text>
        </Pressable>
      );
    })}
  </View>
);

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  tab: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
    backgroundColor: colors.glass,
  },
  tabActive: {
    backgroundColor: colors.accentSoft,
    borderColor: colors.hairlineAccent,
  },
  label: {
    color: colors.inkDim,
    fontSize: 14,
  },
  labelActive: {
    color: colors.accent,
    fontWeight: '700',
  },
});