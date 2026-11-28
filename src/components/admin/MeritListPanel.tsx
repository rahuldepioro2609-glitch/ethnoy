// Merit List Engine foundation: Super Admin tab (documentation/MERIT_LIST_GAP_ANALYSIS.md).
// Shows the marks order the server computed, its unresolved ties and data issues, saves the
// reviewed order as a draft version, and exports a version. The server decides everything; this
// panel has no publish, approve, tie-break, cut-off or category control because none is approved.
import React, { useCallback, useState } from 'react';
import { ApiError, apiRequest } from '../../api';
import { Button, Card, DataTable, EmptyState, ErrorState, StatusBadge, TextField } from '../ui';

interface Entry {
  resultId: string; applicationNumber: string; rollNumber: string; isPublished: boolean; totalMarks: number; maxMarks: number;
  positionFrom: number; positionTo: number; tieGroup: number | null; importedRank: number | null; issues: string[];
}
interface Excluded { resultId: string; applicationNumber: string; rollNumber: string; issues: string[] }
interface Preview {
  examCode: string; fingerprint: string; entries: Entry[]; excluded: Excluded[];
  tieGroups: Array<{ tieGroup: number; totalMarks: number; positionFrom: number; positionTo: number; size: number }>;
  summary: { resultCount: number; orderedCount: number; excludedCount: number; publishedCount: number; draftCount: number; tieGroupCount: number; entriesWithIssues: number };
  issueText: Record<string, string>; blockedRules: string[];
}
interface Snapshot { id: string; examCode: string; version: number; status: string; entryCount: number; tieGroupCount: number; issueCount: number; createdBy: string; createdAt: string }

/** "2" or "2–4 (tie)": tied positions are shown as a shared range, never as resolved ranks. */
export const positionLabel = (entry: Pick<Entry, 'positionFrom' | 'positionTo'>) =>
  (entry.positionFrom === entry.positionTo ? String(entry.positionFrom) : `${entry.positionFrom}–${entry.positionTo} (tie)`);

const errorText = (error: unknown) => (error instanceof Error ? error.message : 'The request could not be completed.');

export const MeritListPanel: React.FC = () => {
  const [examCode, setExamCode] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (code: string) => {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const encoded = encodeURIComponent(code.trim());
      const [nextPreview, history] = await Promise.all([
        apiRequest<Preview>(`/api/admin/merit-lists/${encoded}/preview`),
        apiRequest<{ snapshots: Snapshot[] }>(`/api/admin/merit-lists/${encoded}/snapshots`),
      ]);
      setPreview(nextPreview);
      setSnapshots(history.snapshots);
    } catch (caught) {
      setPreview(null);
      setSnapshots([]);
      setError(errorText(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  const save = async () => {
    if (!preview) return;
    setSaving(true);
    setError(null);
    try {
      const created = await apiRequest<{ snapshot: { version: number } }>(`/api/admin/merit-lists/${encodeURIComponent(preview.examCode)}/snapshots`, {
        method: 'POST', body: JSON.stringify({ expectedFingerprint: preview.fingerprint }),
      });
      await load(preview.examCode);
      setNotice(`Saved as draft version ${created.snapshot.version}.`);
    } catch (caught) {
      // 409: the results changed since the preview, or these exact results are already saved.
      setError(caught instanceof ApiError && caught.status === 409 ? `${caught.message} Nothing was saved.` : errorText(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <Card
        title="Merit lists (draft)"
        headingLevel={3}
        description="Orders an exam's result records by total marks and checks them for errors. Results are never changed here. Visible to Super Admins only; saving and exporting are recorded in the audit log."
      >
        <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); if (examCode.trim()) void load(examCode); }}>
          <TextField label="Exam code" value={examCode} onChange={(event) => setExamCode(event.target.value)} required maxLength={30} hint="For example DEMO-2027." />
          <Button type="submit" size="sm" loading={loading}>Preview</Button>
        </form>
        {preview && (
          <div role="note" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <p className="font-semibold">Not applied yet (waiting for client approval):</p>
            <ul className="mt-1 list-disc pl-5">{preview.blockedRules.map((rule) => <li key={rule}>{rule}</li>)}</ul>
            <p className="mt-1">Equal totals are shown as a shared position range. They are not ranks.</p>
          </div>
        )}
      </Card>

      {error && <ErrorState description={error} onRetry={preview ? () => void load(preview.examCode) : undefined} />}
      {notice && <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</p>}

      {preview && (
        <>
          <Card
            title={`${preview.examCode}: current order`}
            headingLevel={3}
            description={`${preview.summary.orderedCount} ordered · ${preview.summary.excludedCount} left out · ${preview.summary.tieGroupCount} tie groups · ${preview.summary.entriesWithIssues} with issues · ${preview.summary.publishedCount} published / ${preview.summary.draftCount} draft results`}
            actions={<Button type="button" size="sm" loading={saving} disabled={!preview.entries.length && !preview.excluded.length} onClick={() => void save()}>Save as draft version</Button>}
            padded={false}
          >
            <DataTable
              caption={`Merit order for ${preview.examCode}`}
              captionHidden
              rows={preview.entries}
              rowKey={(row) => row.resultId}
              emptyTitle="No result records"
              emptyDescription="Import results for this exam first."
              columns={[
                { key: 'position', header: 'Position', render: (row) => <span className="whitespace-nowrap font-semibold">{positionLabel(row)}</span> },
                { key: 'roll', header: 'Roll number', isRowHeader: true, render: (row) => row.rollNumber },
                { key: 'application', header: 'Application', render: (row) => row.applicationNumber },
                { key: 'marks', header: 'Marks', align: 'right', render: (row) => `${row.totalMarks} / ${row.maxMarks}` },
                { key: 'imported', header: 'Imported rank', align: 'right', render: (row) => row.importedRank ?? '—' },
                { key: 'state', header: 'Result', render: (row) => <StatusBadge status={row.isPublished ? 'approved' : 'pending'} label={row.isPublished ? 'Published' : 'Draft'} /> },
                { key: 'issues', header: 'Issues', render: (row) => (row.issues.length
                  ? <ul className="max-w-xs list-disc pl-4 text-xs text-rose-800">{row.issues.map((code) => <li key={code}>{preview.issueText[code] ?? code}</li>)}</ul>
                  : '—') },
              ]}
            />
          </Card>

          {preview.excluded.length > 0 && (
            <Card title="Left out of the order" headingLevel={3} description="These results cannot be ordered until their scorecards are corrected and imported again.">
              <ul className="space-y-1 text-sm">{preview.excluded.map((row) => (
                <li key={row.resultId}><span className="font-semibold">{row.rollNumber}</span> ({row.applicationNumber}): {row.issues.map((code) => preview.issueText[code] ?? code).join(' ')}</li>
              ))}</ul>
            </Card>
          )}

          <Card title="Saved draft versions" headingLevel={3} description="Versions are never changed or deleted. Saving the same results again is refused.">
            {snapshots.length === 0 ? <EmptyState title="No saved versions yet" /> : (
              <DataTable
                caption={`Saved merit-list versions for ${preview.examCode}`}
                captionHidden
                rows={snapshots}
                rowKey={(row) => row.id}
                columns={[
                  { key: 'version', header: 'Version', isRowHeader: true, render: (row) => `v${row.version}` },
                  { key: 'status', header: 'Status', render: (row) => <StatusBadge status="pending" label={row.status} /> },
                  { key: 'entries', header: 'Entries', align: 'right', render: (row) => row.entryCount },
                  { key: 'ties', header: 'Tie groups', align: 'right', render: (row) => row.tieGroupCount },
                  { key: 'issues', header: 'Issues', align: 'right', render: (row) => row.issueCount },
                  { key: 'created', header: 'Saved', render: (row) => new Date(row.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) },
                  { key: 'export', header: 'Export', render: (row) => (
                    <a className="font-semibold text-[#0B2E59] underline" href={`/api/admin/merit-lists/snapshots/${encodeURIComponent(row.id)}/export`} download>CSV</a>
                  ) },
                ]}
              />
            )}
          </Card>
        </>
      )}
    </div>
  );
};
