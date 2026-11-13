import React from 'react';
import { Button } from './Button.tsx';
import { Spinner } from './Spinner.tsx';
import { cx } from './tones.ts';

export interface EmptyStateProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Decorative icon (hidden from assistive technology). */
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({ title, description, icon, action, className }) => (
  <div className={cx('flex flex-col items-center px-6 py-10 text-center', className)}>
    {icon && <div aria-hidden="true" className="mb-3 rounded-full bg-eltnoy-surface-subtle p-3 text-eltnoy-ink-subtle">{icon}</div>}
    <p className="text-sm font-semibold text-eltnoy-ink">{title}</p>
    {description && <p className="mt-1 max-w-md text-sm text-eltnoy-ink-muted">{description}</p>}
    {action && <div className="mt-4">{action}</div>}
  </div>
);

export interface LoadingStateProps {
  /** Announced to screen readers and shown beside the spinner. */
  label?: string;
  className?: string;
}

/** A polite live region, so assistive technology announces loading without interrupting. */
export const LoadingState: React.FC<LoadingStateProps> = ({ label = 'Loading…', className }) => (
  <div role="status" aria-live="polite" className={cx('flex items-center justify-center gap-2 px-6 py-10 text-sm text-eltnoy-ink-muted', className)}>
    <Spinner className="h-5 w-5 text-eltnoy-teal-600" />
    <span>{label}</span>
  </div>
);

export interface ErrorStateProps {
  title?: React.ReactNode;
  /** User-safe message only: never pass raw server errors, stack traces or identifiers. */
  description?: React.ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  retrying?: boolean;
  className?: string;
}

/** role="alert": announced immediately when it appears. */
export const ErrorState: React.FC<ErrorStateProps> = ({
  title = 'Something went wrong',
  description = 'Please try again. If the problem continues, contact support.',
  onRetry,
  retryLabel = 'Try again',
  retrying = false,
  className,
}) => (
  <div role="alert" className={cx('rounded-xl border border-eltnoy-danger/25 bg-eltnoy-danger-soft px-5 py-4', className)}>
    <p className="text-sm font-semibold text-eltnoy-danger">{title}</p>
    {description && <p className="mt-1 text-sm text-eltnoy-ink">{description}</p>}
    {onRetry && (
      <Button variant="secondary" size="sm" className="mt-3" onClick={onRetry} loading={retrying}>
        {retryLabel}
      </Button>
    )}
  </div>
);
