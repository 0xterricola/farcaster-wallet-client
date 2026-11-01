import { Platform } from 'react-native';

/**
 * Fiddy's design tokens, taken from the client design project
 * (OpenDesign fiddy-client-4695 / tokens.css): chartreuse on near-black, with
 * the glass surfaces from the Solid Glass language.
 */
export const colors = {
  /** Page background — tokens.css `--bg`. */
  bg: '#161715',
  /** Slightly lifted background for the top of the gradient. */
  bgLift: '#1C1F1A',
  /** Glass surface fill. */
  glass: 'rgba(255, 255, 255, 0.045)',
  glassStrong: 'rgba(255, 255, 255, 0.075)',
  /** Hairline that reads as glass rather than as a box. */
  hairline: 'rgba(243, 245, 236, 0.10)',
  /** Chartreuse hairline for accented surfaces. */
  hairlineAccent: 'rgba(212, 255, 63, 0.28)',
  accent: '#D4FF3F',
  accentSoft: 'rgba(212, 255, 63, 0.12)',
  onAccent: '#161715',
  ink: '#F3F5EC',
  inkDim: '#A8AFA0',
  inkFaint: '#71786B',
  danger: '#FF8A65',
  warning: '#FFD166',
} as const;

export const fonts = {
  mono: Platform.select({ ios: 'Menlo', default: 'monospace' }) as string,
} as const;

export const radii = {
  pill: 999,
  card: 18,
  small: 12,
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;