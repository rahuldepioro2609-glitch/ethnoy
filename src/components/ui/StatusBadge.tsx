import React from 'react';
import { cx, humanizeStatus, statusTone, toneStyles, type Tone } from './tones.ts';

export interface StatusBadgeProps {
  /** A stored status value such as "under_review"; picks the tone and default label. */
  status?: string;
  /** Visible label. Overrides the humanized status (use for translations). Colour is never the only signal. */
  label?: React.ReactNode;
  /** Explicit tone; overrides the status mapping. */
  tone?: Tone;
  className?: string;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, label, tone, className }) => {
  const resolved = toneStyles[tone ?? (status ? statusTone(status) : 'neutral')];
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset', resolved.className, className)}>
      <span aria-hidden="true" className={cx('h-1.5 w-1.5 rounded-full', resolved.dotClassName)} />
      {label ?? (status ? humanizeStatus(status) : null)}
    </span>
  );
};
