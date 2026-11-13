import React from 'react';
import type { ColorToken } from '../../utils/designTokens.ts';
import { cx, focusRing } from './tones.ts';
import { Spinner } from './Spinner.tsx';

export type ButtonVariant = 'primary' | 'accent' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

/** fg/bg name the tokens for contrast tests (bg 'surface' = transparent over a white surface). */
export const buttonVariants: Record<ButtonVariant, { fg: ColorToken; bg: ColorToken; className: string }> = {
  primary: { fg: 'surface', bg: 'navy-800', className: 'bg-eltnoy-navy-800 text-eltnoy-surface hover:bg-eltnoy-navy-900' },
  accent: { fg: 'surface', bg: 'teal-700', className: 'bg-eltnoy-teal-700 text-eltnoy-surface hover:bg-eltnoy-navy-800' },
  secondary: { fg: 'ink', bg: 'surface', className: 'bg-eltnoy-surface text-eltnoy-ink ring-1 ring-inset ring-eltnoy-border hover:bg-eltnoy-surface-muted' },
  ghost: { fg: 'navy-800', bg: 'surface', className: 'bg-transparent text-eltnoy-navy-800 hover:bg-eltnoy-surface-subtle' },
  danger: { fg: 'surface', bg: 'danger', className: 'bg-eltnoy-danger text-eltnoy-surface hover:bg-eltnoy-ink' },
};

const sizes: Record<ButtonSize, string> = {
  sm: 'min-h-9 px-3 text-sm gap-1.5',
  md: 'min-h-11 px-4 text-sm gap-2', // 44px touch target
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, sets aria-busy and blocks clicks while keeping the label readable. */
  loading?: boolean;
  /** Optional decorative icon (hidden from assistive technology). */
  icon?: React.ReactNode;
  fullWidth?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading = false, icon, fullWidth = false, type = 'button', disabled, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex items-center justify-center rounded-lg font-semibold transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-60',
        focusRing,
        sizes[size],
        buttonVariants[variant].className,
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner className="h-4 w-4" /> : icon ? <span aria-hidden="true" className="inline-flex shrink-0">{icon}</span> : null}
      <span>{children}</span>
    </button>
  );
});
