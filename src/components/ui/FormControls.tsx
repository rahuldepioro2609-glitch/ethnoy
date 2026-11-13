import React, { useId } from 'react';
import { cx, focusRing } from './tones.ts';

interface FieldMeta {
  label: React.ReactNode;
  /** Help text linked through aria-describedby. */
  hint?: React.ReactNode;
  /** Error text: sets aria-invalid and is linked through aria-describedby. */
  error?: React.ReactNode;
  required?: boolean;
}

interface FieldIds { inputId: string; hintId?: string; errorId?: string; describedBy?: string }

function useFieldIds(explicitId: string | undefined, hint: unknown, error: unknown): FieldIds {
  const generated = useId();
  const inputId = explicitId ?? generated;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return { inputId, hintId, errorId, describedBy };
}

const controlClass = (invalid: boolean) => cx(
  'block w-full rounded-lg border bg-eltnoy-surface px-3 py-2.5 text-sm text-eltnoy-ink placeholder:text-eltnoy-ink-subtle',
  'disabled:cursor-not-allowed disabled:bg-eltnoy-surface-subtle disabled:text-eltnoy-ink-muted',
  invalid ? 'border-eltnoy-danger' : 'border-eltnoy-border hover:border-eltnoy-ink-subtle',
  focusRing,
);

const FieldShell: React.FC<FieldMeta & { ids: FieldIds; children: React.ReactNode }> = ({ label, hint, error, required, ids, children }) => (
  <div className="space-y-1.5">
    <label htmlFor={ids.inputId} className="block text-sm font-semibold text-eltnoy-ink">
      {label}
      {required && <span aria-hidden="true" className="ml-0.5 text-eltnoy-danger">*</span>}
    </label>
    {children}
    {hint && <p id={ids.hintId} className="text-xs text-eltnoy-ink-muted">{hint}</p>}
    {error && <p id={ids.errorId} className="text-xs font-semibold text-eltnoy-danger">{error}</p>}
  </div>
);

/** Native required/aria-invalid/aria-describedby wiring shared by every control. */
function controlA11y(ids: FieldIds, error: unknown, required?: boolean) {
  return { id: ids.inputId, required, 'aria-invalid': error ? true : undefined, 'aria-describedby': ids.describedBy } as const;
}

export type TextFieldProps = FieldMeta & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'required'>;

export const TextField = React.forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, error, required, id, className, type = 'text', ...rest }, ref,
) {
  const ids = useFieldIds(id, hint, error);
  return (
    <FieldShell label={label} hint={hint} error={error} required={required} ids={ids}>
      <input ref={ref} type={type} {...controlA11y(ids, error, required)} className={cx(controlClass(Boolean(error)), className)} {...rest} />
    </FieldShell>
  );
});

export type TextAreaProps = FieldMeta & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'required'>;

export const TextArea = React.forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { label, hint, error, required, id, className, rows = 4, ...rest }, ref,
) {
  const ids = useFieldIds(id, hint, error);
  return (
    <FieldShell label={label} hint={hint} error={error} required={required} ids={ids}>
      <textarea ref={ref} rows={rows} {...controlA11y(ids, error, required)} className={cx(controlClass(Boolean(error)), className)} {...rest} />
    </FieldShell>
  );
});

export interface SelectOption { value: string; label: string; disabled?: boolean }

export type SelectFieldProps = FieldMeta & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'required'> & {
  options: ReadonlyArray<SelectOption>;
  /** Adds a first, unselectable option with an empty value. */
  placeholder?: string;
};

export const SelectField = React.forwardRef<HTMLSelectElement, SelectFieldProps>(function SelectField(
  { label, hint, error, required, id, className, options, placeholder, ...rest }, ref,
) {
  const ids = useFieldIds(id, hint, error);
  return (
    <FieldShell label={label} hint={hint} error={error} required={required} ids={ids}>
      <select ref={ref} {...controlA11y(ids, error, required)} className={cx(controlClass(Boolean(error)), className)} {...rest}>
        {placeholder !== undefined && <option value="" disabled>{placeholder}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>
        ))}
      </select>
    </FieldShell>
  );
});

export type CheckboxProps = Omit<FieldMeta, 'label'> & { label: React.ReactNode } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'required'>;

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, hint, error, required, id, className, ...rest }, ref,
) {
  const ids = useFieldIds(id, hint, error);
  return (
    <div className="space-y-1">
      <div className="flex items-start gap-2.5">
        <input
          ref={ref}
          type="checkbox"
          {...controlA11y(ids, error, required)}
          className={cx('mt-0.5 h-5 w-5 shrink-0 rounded border-eltnoy-border accent-eltnoy-teal-700', focusRing, className)}
          {...rest}
        />
        <label htmlFor={ids.inputId} className="text-sm text-eltnoy-ink">
          {label}
          {required && <span aria-hidden="true" className="ml-0.5 text-eltnoy-danger">*</span>}
        </label>
      </div>
      {hint && <p id={ids.hintId} className="pl-7.5 text-xs text-eltnoy-ink-muted">{hint}</p>}
      {error && <p id={ids.errorId} className="pl-7.5 text-xs font-semibold text-eltnoy-danger">{error}</p>}
    </div>
  );
});
