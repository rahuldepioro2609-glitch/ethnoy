// Small building blocks shared by the Create Examination wizard steps.
import React, { useEffect, useId, useRef } from 'react';
import { Check } from 'lucide-react';
import { WIZARD_STEPS, type WizardStepKey } from '../../../utils/examWizard';

export const inputClass = 'block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100 disabled:bg-slate-100 disabled:text-slate-500';

export const Stepper: React.FC<{ current: WizardStepKey; done: ReadonlySet<WizardStepKey>; onSelect: (step: WizardStepKey) => void }> = ({ current, done, onSelect }) => {
  const navRef = useRef<HTMLElement>(null);
  // On narrow screens the stepper scrolls sideways: keep the current step in view.
  useEffect(() => {
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="step"]');
    if (nav && active && nav.scrollWidth > nav.clientWidth) nav.scrollTo({ left: Math.max(0, active.offsetLeft - 8), behavior: 'smooth' });
  }, [current]);
  return (
  <nav ref={navRef} aria-label="Create examination steps" className="-mx-1 overflow-x-auto pb-1">
    <ol className="flex min-w-max items-center gap-1 px-1 sm:min-w-0">
      {WIZARD_STEPS.map((step, index) => {
        const active = step.key === current;
        const complete = done.has(step.key) && !active;
        return (
          <li key={step.key} className="flex flex-1 items-center gap-1">
            <button
              type="button"
              onClick={() => onSelect(step.key)}
              aria-current={active ? 'step' : undefined}
              className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left transition ${active ? 'bg-emerald-50 ring-1 ring-emerald-200' : 'hover:bg-slate-50'}`}
            >
              <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-sm font-black ${active ? 'bg-emerald-700 text-white' : complete ? 'bg-emerald-100 text-emerald-800' : 'border border-slate-300 bg-white text-slate-600'}`}>
                {complete ? <Check className="h-4 w-4" aria-hidden="true" /> : index + 1}
              </span>
              <span className="min-w-0">
                <span className={`block text-xs font-bold leading-tight ${active ? 'text-emerald-800' : 'text-slate-800'}`}>{step.title}</span>
                <span className="block text-[11px] leading-tight text-slate-500">{step.subtitle}</span>
              </span>
            </button>
            {index < WIZARD_STEPS.length - 1 && <span aria-hidden="true" className="hidden h-px w-4 shrink-0 bg-slate-300 lg:block" />}
          </li>
        );
      })}
    </ol>
  </nav>
  );
};

export const Panel: React.FC<React.PropsWithChildren<{ title: string; icon?: React.ReactNode; description?: string; actions?: React.ReactNode; className?: string }>> = ({ title, icon, description, actions, className = '', children }) => (
  <section className={`rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5 ${className}`}>
    <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
      <div className="flex items-start gap-2">
        {icon && <span className="mt-0.5 text-emerald-700" aria-hidden="true">{icon}</span>}
        <div>
          <h3 className="text-base font-extrabold text-[#0B2E59]">{title}</h3>
          {description && <p className="mt-0.5 text-xs text-slate-500">{description}</p>}
        </div>
      </div>
      {actions}
    </div>
    {children}
  </section>
);

export const Field: React.FC<React.PropsWithChildren<{ label: string; required?: boolean; hint?: string; className?: string; htmlFor?: string }>> = ({ label, required, hint, className = '', htmlFor, children }) => (
  <div className={className}>
    <label htmlFor={htmlFor} className="mb-1 block text-xs font-bold text-slate-700">
      {label}{required && <span className="ml-0.5 text-rose-600" aria-hidden="true">*</span>}
    </label>
    {children}
    {hint && <p className="mt-1 text-[11px] text-slate-500">{hint}</p>}
  </div>
);

/** Text input with its label wired up. */
export const TextInput: React.FC<{ label: string; value: string; onChange: (value: string) => void; required?: boolean; hint?: string; placeholder?: string; type?: string; maxLength?: number; className?: string; disabled?: boolean; min?: string; max?: string }> = ({ label, value, onChange, required, hint, placeholder, type = 'text', maxLength, className, disabled, min, max }) => {
  const id = useId();
  return (
    <Field label={label} required={required} hint={hint} className={className} htmlFor={id}>
      <input id={id} type={type} className={inputClass} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} maxLength={maxLength} disabled={disabled} min={min} max={max} aria-required={required || undefined} />
    </Field>
  );
};

export const TextBox: React.FC<{ label: string; value: string; onChange: (value: string) => void; maxLength: number; rows?: number; hint?: string; placeholder?: string; className?: string; required?: boolean }> = ({ label, value, onChange, maxLength, rows = 3, hint, placeholder, className, required }) => {
  const id = useId();
  return (
    <Field label={label} hint={hint} className={className} htmlFor={id} required={required}>
      <textarea id={id} className={inputClass} rows={rows} value={value} maxLength={maxLength} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
      <p className="mt-0.5 text-right text-[11px] text-slate-400">{value.length} / {maxLength}</p>
    </Field>
  );
};

export const Select: React.FC<{ label: string; value: string; onChange: (value: string) => void; options: ReadonlyArray<{ value: string; label: string }>; required?: boolean; hint?: string; className?: string }> = ({ label, value, onChange, options, required, hint, className }) => {
  const id = useId();
  return (
    <Field label={label} required={required} hint={hint} className={className} htmlFor={id}>
      <select id={id} className={inputClass} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </Field>
  );
};

/** A nullable number: empty input means "no limit" (null). */
export const NumberInput: React.FC<{ label: string; value: number | null; onChange: (value: number | null) => void; min?: number; max?: number; step?: string; hint?: string; className?: string; required?: boolean; suffix?: string }> = ({ label, value, onChange, min, max, step = '1', hint, className, required, suffix }) => {
  const id = useId();
  return (
    <Field label={label} hint={hint} className={className} htmlFor={id} required={required}>
      <div className="relative">
        <input
          id={id} type="number" inputMode="decimal" className={inputClass} min={min} max={max} step={step}
          value={value === null ? '' : String(value)}
          onChange={(event) => {
            const raw = event.target.value;
            if (raw === '') { onChange(null); return; }
            const parsed = Number(raw);
            if (Number.isFinite(parsed)) onChange(parsed);
          }}
        />
        {suffix && <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-500">{suffix}</span>}
      </div>
    </Field>
  );
};

export const Toggle: React.FC<{ checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean; showLabel?: boolean }> = ({ checked, onChange, label, disabled, showLabel }) => (
  <label className={`inline-flex items-center gap-2 ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}>
    <span className="relative inline-flex">
      <input type="checkbox" role="switch" className="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} aria-label={showLabel ? undefined : label} />
      <span className="h-5 w-9 rounded-full bg-slate-300 transition peer-checked:bg-emerald-600 peer-focus-visible:ring-2 peer-focus-visible:ring-emerald-300" />
      <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition peer-checked:translate-x-4" />
    </span>
    {showLabel && <span className="text-sm text-slate-700">{label}</span>}
  </label>
);

export const CheckOption: React.FC<{ checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean; hint?: string }> = ({ checked, onChange, label, disabled, hint }) => (
  <label className={`flex items-start gap-2 text-sm text-slate-700 ${disabled ? 'opacity-60' : ''}`}>
    <input type="checkbox" className="mt-0.5 h-4 w-4 rounded border-slate-300 accent-emerald-700" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
    <span>{label}{hint && <span className="block text-[11px] text-slate-500">{hint}</span>}</span>
  </label>
);

/** Tabs inside a step (keyboard-accessible buttons). */
export function Tabs<T extends string>({ tabs, current, onChange, label }: { tabs: ReadonlyArray<{ key: T; label: string; icon?: React.ReactNode }>; current: T; onChange: (key: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-slate-50 p-1">
      {tabs.map((tab) => (
        <button
          key={tab.key} type="button" role="tab" aria-selected={tab.key === current} onClick={() => onChange(tab.key)}
          className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold transition ${tab.key === current ? 'bg-white text-emerald-800 shadow-sm ring-1 ring-emerald-200' : 'text-slate-600 hover:text-slate-900'}`}
        >
          {tab.icon && <span aria-hidden="true">{tab.icon}</span>}{tab.label}
        </button>
      ))}
    </div>
  );
}

export const IssueList: React.FC<{ issues: string[]; title?: string }> = ({ issues, title = 'Fix these before continuing:' }) => (
  issues.length === 0 ? null : (
    <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
      <p className="font-bold">{title}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
    </div>
  )
);

export const InfoNote: React.FC<React.PropsWithChildren<{ tone?: 'info' | 'warning' }>> = ({ tone = 'info', children }) => (
  <div className={`rounded-xl border p-3 text-xs leading-relaxed ${tone === 'warning' ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-sky-200 bg-sky-50 text-sky-900'}`}>{children}</div>
);

export function toggleInList<T>(list: readonly T[], value: T, on: boolean): T[] {
  return on ? (list.includes(value) ? [...list] : [...list, value]) : list.filter((item) => item !== value);
}
