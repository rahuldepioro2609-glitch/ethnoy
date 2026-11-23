import React from 'react';
import { cx } from './tones.ts';

/** Decorative spinner. Always aria-hidden: pair it with visible or screen-reader text. Spins only if motion is allowed. */
export const Spinner: React.FC<{ className?: string }> = ({ className }) => (
  <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" className={cx('shrink-0 motion-safe:animate-spin', className)}>
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
  </svg>
);
