import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, radii, spacing } from '~/theme';

interface GlassCardProps {
  children: ReactNode;
  /** Chartreuse hairline — use for the one card that is the point of a screen. */
  accent?: boolean;
  style?: StyleProp<ViewStyle>;
  padded?: boolean;
}

/**
 * A Solid Glass surface: a low-alpha fill over the page gradient, a hairline
 * border, and no shadow (shadows read as "box", glass reads as "pane").
 */
export const GlassCard = ({
  children,
  accent = false,
  style,
  padded = true,
}: GlassCardProps) => (
  <View style={[styles.shell, accent && styles.shellAccent, style]}>
    <LinearGradient
      colors={
        accent
          ? ['rgba(212,255,63,0.10)', 'rgba(212,255,63,0.03)']
          : ['rgba(255,255,255,0.07)', 'rgba(255,255,255,0.03)']
      }
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[styles.fill, padded && styles.padded]}
    >
      {children}
    </LinearGradient>
  </View>
);

const styles = StyleSheet.create({
  shell: {
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
    overflow: 'hidden',
  },
  shellAccent: {
    borderColor: colors.hairlineAccent,
  },
  fill: {
    backgroundColor: colors.glass,
  },
  padded: {
    padding: spacing.lg,
  },
});