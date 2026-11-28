// Institute Workspace: on-screen reports of the Institute's own records (POST /api/center/reports/preview).
// - Fixed datasets only: applications, examinations, attendance, results. Fees are not offered: nothing
//   records fee transactions yet (payments, F-6).
// - At most 200 rows are shown; when there are more, the screen says so instead of implying completeness.
// - No file export: A-07 keeps full exports with the Super Admin, and Institute exports are open (PERM-05).
import React, { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../api';
import { examStatusLabel } from '../../utils/workspaceExams';
import { ATTENDANCE_LABEL } from './AttendancePanel';
import { REVIEW_LABEL } from './ApplicationsPanel';
import { RESULT_STATUS_LABEL } from './ResultsPanel';
import { sendWorkspaceWrite } from './useWorkspaceResource';

export type ReportDataset = 'applications' | 'exams' | 'attendance' | 'results';
type Row = Record<string, unknown>;
interface Preview { dataset: ReportDataset; generatedAt: string; rowCount: number; truncated: boolean; rows: Row[] }

interface Column { key: string; label: string; format?: (value: unknown) => string }

const dateTime = (value: unknown) => {
  const time = typeof value === 'string' ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(time) ? new Date(time).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
};
const dateOnly = (value: unknown) => {
  const time = typeof value === 'string' ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(time) ? new Date(time).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }) : '—';
};
const number = (value: unknown) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? '—' : String(Math.round(Number(value) * 100) / 100));
const label = (map: Readonly<Record<string, string>>) => (value: unknown) => (typeof value === 'string' ? map[value] ?? value : '—');
const plain = (value: unknown) => (value === null || value === undefined || value === '' ? '—' : String(value));

/** Columns shown per dataset, and the status column the summary counts. */
export const REPORTS: Readonly<Record<ReportDataset, { title: string; statusKey: string; statusLabel: (value: unknown) => string; columns: readonly Column[] }>> = Object.freeze({
  applications: {
    title: 'Applications', statusKey: 'review_status', statusLabel: label(REVIEW_LABEL),
    columns: [
      { key: 'application_number', label: 'Application' }, { key: 'candidate_name', label: 'Candidate' }, { key: 'exam_code', label: 'Exam' },
      { key: 'stage', label: 'Stage', format: label({ started: 'Started', profile: 'Profile', documents: 'Documents', submitted: 'Submitted' }) }, { key: 'payment_status', label: 'Fee', format: label({ unpaid: 'Unpaid', waived: 'Waived' }) },
      { key: 'review_status', label: 'Review', format: label(REVIEW_LABEL) }, { key: 'created_at', label: 'Received', format: dateTime },
    ],
  },
  exams: {
    title: 'Examinations', statusKey: 'lifecycle_status', statusLabel: examStatusLabel,
    columns: [
      { key: 'exam_code', label: 'Code' }, { key: 'title', label: 'Title' }, { key: 'category', label: 'Category' }, { key: 'mode', label: 'Mode' },
      { key: 'exam_date', label: 'Exam date', format: dateOnly }, { key: 'lifecycle_status', label: 'Status', format: examStatusLabel }, { key: 'created_at', label: 'Created', format: dateTime },
    ],
  },
  attendance: {
    title: 'Attendance marks', statusKey: 'status', statusLabel: label(ATTENDANCE_LABEL),
    columns: [
      { key: 'roll_number', label: 'Roll number' }, { key: 'candidate_name', label: 'Candidate' }, { key: 'exam_code', label: 'Exam' },
      { key: 'center_name', label: 'Centre' }, { key: 'session_name', label: 'Session' }, { key: 'status', label: 'Status', format: label(ATTENDANCE_LABEL) },
      { key: 'reason', label: 'Reason' }, { key: 'created_at', label: 'Marked at', format: dateTime },
    ],
  },
  results: {
    title: 'Results', statusKey: 'evaluation_status', statusLabel: label(RESULT_STATUS_LABEL),
    columns: [
      { key: 'exam_code', label: 'Exam' }, { key: 'roll_number', label: 'Roll number' }, { key: 'candidate_name', label: 'Candidate' },
      { key: 'raw_score', label: 'Score', format: number }, { key: 'max_score', label: 'Out of', format: number }, { key: 'percentage', label: '%', format: number },
      { key: 'qualifying_status', label: 'Qualifying', format: label({ passed: 'Passed', failed: 'Failed', pending: 'Pending' }) }, { key: 'evaluation_status', label: 'Status', format: label(RESULT_STATUS_LABEL) },
    ],
  },
});

/** Counts per status among the rows shown, largest first. */
export function statusCounts(rows: readonly Row[], statusKey: string, toLabel: (value: unknown) => string): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = toLabel(row[statusKey]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'success'; data: Preview };

export const ReportsPanel: React.FC = () => {
  const [dataset, setDataset] = useState<ReportDataset>('applications');
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    sendWorkspaceWrite<Preview>('/api/center/reports/preview', 'POST', { dataset })
      .then((data) => { if (!cancelled) setState({ status: 'success', data }); })
      .catch((error: unknown) => { if (!cancelled) setState({ status: 'error', message: error instanceof ApiError || error instanceof Error ? error.message : 'The request could not be completed.' }); });
    return () => { cancelled = true; };
  }, [dataset, attempt]);

  const report = REPORTS[dataset];
  const summary = useMemo(() => (state.status === 'success' ? statusCounts(state.data.rows, report.statusKey, report.statusLabel) : []), [state, report]);

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6" aria-labelledby="workspace-reports-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="workspace-reports-heading" className="text-lg font-extrabold text-[#0B2E59]">Workspace records</h2>
          <p className="mt-1 text-sm text-slate-600">Your institute's own records, read from the server each time. Results are grouped by examination, newest examination first; everything else is newest first. Downloading or exporting reports is not available.</p>
        </div>
        <button type="button" onClick={() => setAttempt((value) => value + 1)} disabled={state.status === 'loading'} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-bold text-slate-700 disabled:opacity-50">Refresh</button>
      </div>

      <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Choose a report">
        {(Object.keys(REPORTS) as ReportDataset[]).map((key) => (
          <button key={key} type="button" onClick={() => setDataset(key)} aria-pressed={dataset === key} className={`rounded-full px-3 py-1.5 text-xs font-bold ${dataset === key ? 'bg-[#0B2E59] text-white' : 'bg-slate-100 text-slate-700'}`}>{REPORTS[key].title}</button>
        ))}
      </div>

      {state.status === 'loading' && <p role="status" className="mt-5 rounded-xl bg-slate-50 p-5 text-sm text-slate-600">Loading {report.title.toLowerCase()}…</p>}
      {state.status === 'error' && <div role="alert" className="mt-5 rounded-xl bg-rose-50 p-5 text-sm text-rose-800">The report could not be loaded: {state.message}<button type="button" onClick={() => setAttempt((value) => value + 1)} className="ml-3 font-bold underline">Try again</button></div>}
      {state.status === 'success' && (
        <>
          <p className="mt-4 text-xs text-slate-500">
            {state.data.rowCount} {state.data.rowCount === 1 ? 'row' : 'rows'} · generated {dateTime(state.data.generatedAt)}
          </p>
          {state.data.truncated && <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">Only the first {state.data.rowCount} rows are shown. More records exist and are not included in these counts.</p>}
          {state.data.rows.length === 0 ? <p className="mt-3 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">No {report.title.toLowerCase()} recorded yet.</p> : (
            <>
              <ul className="mt-3 flex flex-wrap gap-2" aria-label="Count by status">
                {summary.map(([name, count]) => <li key={name} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700"><span className="font-bold text-slate-900">{count}</span> {name}</li>)}
              </ul>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[760px] text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>{report.columns.map((column) => <th key={column.key} className="p-3">{column.label}</th>)}</tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {state.data.rows.map((row, index) => (
                      <tr key={`${index}-${String(row[report.columns[0].key])}`}>
                        {report.columns.map((column) => <td key={column.key} className="p-3 text-slate-700">{(column.format ?? plain)(row[column.key])}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
};
