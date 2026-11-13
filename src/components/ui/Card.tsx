import React, { useId } from 'react';
import { cx } from './tones.ts';

export interface CardProps {
  title?: React.ReactNode;
  /** Heading level for the title so cards fit the page outline (default 2). */
  headingLevel?: 2 | 3 | 4;
  description?: React.ReactNode;
  /** Buttons or links shown beside the title. */
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  padded?: boolean;
  className?: string;
  children?: React.ReactNode;
}

/** A titled card is a labelled <section>; an untitled card is a plain <div>. */
export const Card: React.FC<CardProps> = ({ title, headingLevel = 2, description, actions, footer, padded = true, className, children }) => {
  const headingId = useId();
  const Heading = `h${headingLevel}` as const;
  const body = (
    <>
      {(title || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-eltnoy-border px-5 py-4">
          <div className="min-w-0">
            {title && <Heading id={headingId} className="text-base font-bold text-eltnoy-ink">{title}</Heading>}
            {description && <p className="mt-1 text-sm text-eltnoy-ink-muted">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
        </div>
      )}
      <div className={padded ? 'px-5 py-4' : undefined}>{children}</div>
      {footer && <div className="border-t border-eltnoy-border bg-eltnoy-surface-muted px-5 py-3">{footer}</div>}
    </>
  );
  const classes = cx('overflow-hidden rounded-xl border border-eltnoy-border bg-eltnoy-surface shadow-sm', className);
  return title
    ? <section aria-labelledby={headingId} className={classes}>{body}</section>
    : <div className={classes}>{body}</div>;
};
