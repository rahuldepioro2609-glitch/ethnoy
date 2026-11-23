import React from 'react';
import { EmptyState, LoadingState } from './States.tsx';
import { cx, focusRing } from './tones.ts';

export interface TableColumn<Row> {
  key: string;
  header: React.ReactNode;
  render: (row: Row) => React.ReactNode;
  align?: 'left' | 'right' | 'center';
  /** Marks the column whose cell names the row (rendered as a row header for screen readers). */
  isRowHeader?: boolean;
  className?: string;
}

export interface DataTableProps<Row> {
  /** Required accessible name. Shown as a caption unless captionHidden. */
  caption: string;
  captionHidden?: boolean;
  columns: ReadonlyArray<TableColumn<Row>>;
  rows: ReadonlyArray<Row>;
  rowKey: (row: Row) => string;
  loading?: boolean;
  loadingLabel?: string;
  emptyTitle?: React.ReactNode;
  emptyDescription?: React.ReactNode;
  className?: string;
}

const alignClass = { left: 'text-left', right: 'text-right', center: 'text-center' } as const;

/**
 * Accessible data table. The scroll container is focusable and labelled, so keyboard users can scroll
 * wide tables on small screens. Loading and empty states render inside the table body.
 */
export function DataTable<Row>({
  caption, captionHidden = false, columns, rows, rowKey, loading = false, loadingLabel = 'Loading…',
  emptyTitle = 'Nothing to show yet', emptyDescription, className,
}: DataTableProps<Row>) {
  const status = loading ? 'loading' : rows.length === 0 ? 'empty' : 'rows';
  return (
    <div
      role="region"
      aria-label={caption}
      tabIndex={0}
      className={cx('overflow-x-auto rounded-xl border border-eltnoy-border bg-eltnoy-surface', focusRing, className)}
    >
      <table aria-busy={loading || undefined} className="w-full border-collapse text-sm">
        <caption className={captionHidden ? 'sr-only' : 'px-4 pt-4 text-left text-sm font-semibold text-eltnoy-ink'}>{caption}</caption>
        <thead className="bg-eltnoy-surface-muted">
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cx('whitespace-nowrap border-b border-eltnoy-border px-4 py-3 text-xs font-bold uppercase tracking-wide text-eltnoy-ink-muted', alignClass[column.align ?? 'left'])}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {status === 'loading' && (
            <tr><td colSpan={columns.length}><LoadingState label={loadingLabel} /></td></tr>
          )}
          {status === 'empty' && (
            <tr><td colSpan={columns.length}><EmptyState title={emptyTitle} description={emptyDescription} /></td></tr>
          )}
          {status === 'rows' && rows.map((row) => (
            <tr key={rowKey(row)} className="border-b border-eltnoy-border last:border-b-0 hover:bg-eltnoy-surface-muted">
              {columns.map((column) => {
                const Cell = column.isRowHeader ? 'th' : 'td';
                return (
                  <Cell
                    key={column.key}
                    scope={column.isRowHeader ? 'row' : undefined}
                    className={cx('px-4 py-3 align-top text-eltnoy-ink', column.isRowHeader && 'font-semibold', alignClass[column.align ?? 'left'], column.className)}
                  >
                    {column.render(row)}
                  </Cell>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
