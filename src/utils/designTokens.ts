// ELTNOY design tokens: the single source of truth for brand and UI colours.
// The same values are declared in src/index.css (@theme), and designTokens.test.ts keeps both in sync.
// Navy and the "ELT" wordmark green are the existing brand colours; teal is the UI accent.

export const colorTokens = {
  // Brand
  'navy-950': '#071933',
  'navy-900': '#0B254E',
  'navy-800': '#0B2E59', // primary brand navy (logo, theme-color)
  'brand-green': '#16A34A', // "ELT" wordmark only: large bold text, not body text
  // Accent
  'teal-600': '#0D9488', // accent fills, focus rings, large text and icons
  'teal-700': '#0F766E', // accent text and links on light surfaces
  // Surfaces
  'surface': '#FFFFFF',
  'surface-muted': '#F8FAFC',
  'surface-subtle': '#F1F5F9',
  'border': '#E2E8F0',
  // Text
  'ink': '#0F172A',
  'ink-muted': '#475569',
  'ink-subtle': '#64748B',
  // Status
  'success': '#15803D',
  'warning': '#B45309',
  'danger': '#BE123C',
  'info': '#0369A1',
  // Soft tints for badges, alerts and selected rows
  'teal-soft': '#F0FDFA',
  'success-soft': '#F0FDF4',
  'warning-soft': '#FFFBEB',
  'danger-soft': '#FFF1F2',
  'info-soft': '#F0F9FF',
} as const;

export type ColorToken = keyof typeof colorTokens;

/** WCAG 2.x relative luminance of a #RRGGBB colour. */
export function relativeLuminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`Expected #RRGGBB, got ${hex}`);
  const value = Number.parseInt(match[1], 16);
  const channel = (shift: number) => {
    const c = ((value >> shift) & 0xff) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
}

/** WCAG 2.x contrast ratio between two #RRGGBB colours (1–21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** 'text' = normal body text (AA 4.5:1); 'large' = large/bold text, icons and UI boundaries (AA 3:1). */
export type ContrastUse = 'text' | 'large';

/** Foreground/background pairings the design system permits. Every pair must meet WCAG AA for its use. */
export const approvedPairings: ReadonlyArray<{ fg: ColorToken; bg: ColorToken; use: ContrastUse }> = [
  ...(['ink', 'ink-muted', 'ink-subtle', 'navy-800', 'navy-900', 'teal-700', 'success', 'warning', 'danger', 'info'] as const)
    .flatMap((fg) => (['surface', 'surface-muted'] as const).map((bg) => ({ fg, bg, use: 'text' as const }))),
  ...(['ink', 'ink-muted', 'navy-800', 'teal-700'] as const).map((fg) => ({ fg, bg: 'surface-subtle' as const, use: 'text' as const })),
  { fg: 'surface', bg: 'navy-800', use: 'text' },
  { fg: 'surface', bg: 'navy-900', use: 'text' },
  { fg: 'surface', bg: 'navy-950', use: 'text' },
  { fg: 'surface', bg: 'teal-700', use: 'text' },
  { fg: 'surface', bg: 'danger', use: 'text' },
  { fg: 'teal-700', bg: 'teal-soft', use: 'text' },
  { fg: 'success', bg: 'success-soft', use: 'text' },
  { fg: 'warning', bg: 'warning-soft', use: 'text' },
  { fg: 'danger', bg: 'danger-soft', use: 'text' },
  { fg: 'info', bg: 'info-soft', use: 'text' },
  { fg: 'ink', bg: 'teal-soft', use: 'text' },
  { fg: 'teal-600', bg: 'surface', use: 'large' },
  { fg: 'brand-green', bg: 'surface', use: 'large' },
];

export function minimumContrast(use: ContrastUse): number {
  return use === 'text' ? 4.5 : 3;
}
