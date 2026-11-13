import type { ColorToken } from '../../utils/designTokens.ts';

// Class strings are written out in full so Tailwind can find them; fg/bg name the tokens so tests can check contrast.

export type Tone = 'neutral' | 'accent' | 'info' | 'success' | 'warning' | 'danger';

export const toneStyles: Record<Tone, { fg: ColorToken; bg: ColorToken; className: string; dotClassName: string }> = {
  neutral: { fg: 'ink-muted', bg: 'surface-subtle', className: 'text-eltnoy-ink-muted bg-eltnoy-surface-subtle ring-eltnoy-border', dotClassName: 'bg-eltnoy-ink-subtle' },
  accent: { fg: 'teal-700', bg: 'teal-soft', className: 'text-eltnoy-teal-700 bg-eltnoy-teal-soft ring-eltnoy-teal-600/30', dotClassName: 'bg-eltnoy-teal-600' },
  info: { fg: 'info', bg: 'info-soft', className: 'text-eltnoy-info bg-eltnoy-info-soft ring-eltnoy-info/25', dotClassName: 'bg-eltnoy-info' },
  success: { fg: 'success', bg: 'success-soft', className: 'text-eltnoy-success bg-eltnoy-success-soft ring-eltnoy-success/25', dotClassName: 'bg-eltnoy-success' },
  warning: { fg: 'warning', bg: 'warning-soft', className: 'text-eltnoy-warning bg-eltnoy-warning-soft ring-eltnoy-warning/25', dotClassName: 'bg-eltnoy-warning' },
  danger: { fg: 'danger', bg: 'danger-soft', className: 'text-eltnoy-danger bg-eltnoy-danger-soft ring-eltnoy-danger/25', dotClassName: 'bg-eltnoy-danger' },
};

/**
 * Tones for status values that already exist in the database (applications, institutes, forms,
 * withdrawals, feedback, check-ins). Unknown values fall back to neutral rather than guessing.
 */
const knownStatusTones: Record<string, Tone> = {
  draft: 'neutral',
  submitted: 'info',
  pending: 'warning',
  under_review: 'warning',
  in_progress: 'info',
  approved: 'success',
  verified: 'success',
  admitted: 'success',
  resolved: 'success',
  paid: 'success',
  published: 'success',
  flagged: 'warning',
  rejected: 'danger',
};

export function statusTone(status: string): Tone {
  return knownStatusTones[status] ?? 'neutral';
}

/** "under_review" → "Under review". Callers may pass a translated label instead. */
export function humanizeStatus(status: string): string {
  const words = status.replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1).toLowerCase() : status;
}

/** Shared keyboard focus ring: teal, visible only for keyboard focus. */
export const focusRing = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-eltnoy-teal-600';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
