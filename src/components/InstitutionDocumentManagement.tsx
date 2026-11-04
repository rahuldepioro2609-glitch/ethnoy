import React, { useEffect, useMemo, useState } from 'react';
import { apiRequest } from '../api';
import { SUPER_ADMIN_ONLY_TEXT } from '../utils/adminPermissions';
import {
  INSTITUTION_DOCUMENT_CATEGORIES,
  type InstitutionDocumentCategory,
} from '../utils/institutionDocuments';

type DocumentPolicy = {
  categories: readonly InstitutionDocumentCategory[];
  uploadEnabled: boolean;
  maxBytes: number | null;
  maxDocumentsPerCategory: number | null;
  allowedMediaTypes: string[];
  categoryCardinality: 'single' | 'multiple' | null;
  replacementEnabled: boolean;
  maxVersionsPerDocument: number | null;
  reviewDecisionCodes: string[];
};

type DocumentReview = {
  id: string;
  decision_code: string | null;
  reviewer_remarks: string;
  reviewed_at: string;
  reviewer_name: string;
};

type DocumentVersion = {
  version_id: string;
  document_id: string;
  institution_id: string;
  category: InstitutionDocumentCategory;
  version_number: number;
  detected_media_type: string;
  file_size_bytes: number;
  uploaded_at: string;
  institution_name?: string;
  institution_login_id?: string;
  reviews: DocumentReview[];
};

interface InstitutionDocumentManagementProps {
  role: 'center' | 'official';
  /**
   * Official view only (A-09, P3-D10): preview and download of document content. Defaults to
   * false, so an Official view never offers content unless the caller grants it. The backend
   * enforces the same rule. Center accounts always retrieve their own documents.
   */
  canOpenDocuments?: boolean;
  /** Official view only (A-09): record review remarks and decisions. Defaults to false. */
  canReviewDocuments?: boolean;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} bytes`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function fileExtension(mediaType: string): string {
  if (mediaType === 'application/pdf') return 'pdf';
  if (mediaType === 'image/png') return 'png';
  if (mediaType === 'image/jpeg') return 'jpg';
  return 'document';
}

async function fetchDocumentBlob(version: DocumentVersion, isOfficial: boolean): Promise<Blob> {
  const endpoint = isOfficial
    ? `/api/admin/institution-documents/versions/${encodeURIComponent(version.version_id)}/content`
    : `/api/center/documents/versions/${encodeURIComponent(version.version_id)}/content`;
  const response = await fetch(endpoint, { credentials: 'same-origin' });
  if (!response.ok) {
    let message = `Document retrieval failed (${response.status}).`;
    try {
      const body = await response.json() as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Preserve the HTTP status when the server does not return JSON.
    }
    throw new Error(message);
  }
  const blob = await response.blob();
  if (blob.type !== version.detected_media_type) {
    throw new Error('The retrieved document type did not match its stored metadata.');
  }
  return blob;
}

function uploadDocument(
  endpoint: string,
  file: File,
  onProgress: (percentage: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(endpoint.startsWith('/api/center/documents/') ? 'PUT' : 'POST', endpoint);
    request.withCredentials = true;
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onerror = () => reject(new Error('The document upload could not reach the server.'));
    request.onabort = () => reject(new Error('The document upload was cancelled.'));
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress(100);
        resolve();
        return;
      }
      let message = `Document upload failed (${request.status}).`;
      try {
        const body = JSON.parse(request.responseText) as { error?: string };
        if (body.error) message = body.error;
      } catch {
        // Preserve the HTTP status when the server does not return JSON.
      }
      reject(new Error(message));
    };
    request.send(file);
  });
}

export const InstitutionDocumentManagement: React.FC<InstitutionDocumentManagementProps> = ({
  role,
  canOpenDocuments = false,
  canReviewDocuments = false,
}) => {
  const isOfficial = role === 'official';
  const canOpenContent = isOfficial ? canOpenDocuments : true;
  const canRecordReviews = isOfficial && canReviewDocuments;
  const policyPath = isOfficial
    ? '/api/admin/institution-documents/policy'
    : '/api/center/documents/policy';
  const documentsPath = isOfficial
    ? '/api/admin/institution-documents'
    : '/api/center/documents';
  const [policy, setPolicy] = useState<DocumentPolicy | null>(null);
  const [documents, setDocuments] = useState<DocumentVersion[]>([]);
  const [policyLoading, setPolicyLoading] = useState(true);
  const [documentsLoading, setDocumentsLoading] = useState(true);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [documentsError, setDocumentsError] = useState<string | null>(null);
  const [uploadingCategory, setUploadingCategory] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [remarks, setRemarks] = useState<Record<string, string>>({});
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  const [savingReview, setSavingReview] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ url: string; mediaType: string; title: string } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const loadPolicy = async () => {
    setPolicyLoading(true);
    setPolicyError(null);
    try {
      setPolicy(await apiRequest<DocumentPolicy>(policyPath));
    } catch (loadError) {
      setPolicyError(loadError instanceof Error ? loadError.message : 'Could not load document policy.');
    } finally {
      setPolicyLoading(false);
    }
  };

  const loadDocuments = async () => {
    setDocumentsLoading(true);
    setDocumentsError(null);
    try {
      const result = await apiRequest<{ documents: DocumentVersion[] }>(documentsPath);
      setDocuments(result.documents);
    } catch (loadError) {
      setDocumentsError(loadError instanceof Error ? loadError.message : 'Could not load institution documents.');
    } finally {
      setDocumentsLoading(false);
    }
  };

  useEffect(() => {
    void loadPolicy();
    void loadDocuments();
  }, [policyPath, documentsPath]);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview.url);
  }, [preview]);

  const documentsByCategory = useMemo(() => {
    const grouped = new Map<InstitutionDocumentCategory, DocumentVersion[]>();
    for (const category of INSTITUTION_DOCUMENT_CATEGORIES) grouped.set(category, []);
    for (const document of documents) {
      grouped.get(document.category)?.push(document);
    }
    return grouped;
  }, [documents]);

  const handleUpload = async (
    file: File,
    category: InstitutionDocumentCategory,
    documentId?: string,
  ) => {
    if (!policy?.uploadEnabled || !policy.maxBytes) {
      setUploadError('Uploads are disabled until storage, file type, size, and category policies are configured.');
      return;
    }
    if (file.size > policy.maxBytes) {
      setUploadError(`The selected file exceeds the configured ${formatBytes(policy.maxBytes)} limit.`);
      return;
    }

    setUploadingCategory(category);
    setUploadProgress(0);
    setUploadError(null);
    setSuccess(null);
    const endpoint = documentId
      ? `/api/center/documents/${encodeURIComponent(documentId)}/versions`
      : `/api/center/documents?category=${encodeURIComponent(category)}`;
    try {
      await uploadDocument(endpoint, file, setUploadProgress);
      setSuccess(`${category} document uploaded. The server validated the file content.`);
      await loadDocuments();
    } catch (uploadFailure) {
      setUploadError(uploadFailure instanceof Error ? uploadFailure.message : 'Could not upload the document.');
    } finally {
      setUploadingCategory(null);
      setUploadProgress(0);
    }
  };

  const retrieve = async (version: DocumentVersion, action: 'preview' | 'download') => {
    if (!canOpenContent) return;
    setPreviewError(null);
    try {
      const blob = await fetchDocumentBlob(version, isOfficial);
      const url = URL.createObjectURL(blob);
      if (action === 'download') {
        const link = document.createElement('a');
        link.href = url;
        link.download = `institution-document-v${version.version_number}.${fileExtension(version.detected_media_type)}`;
        link.click();
        URL.revokeObjectURL(url);
      } else {
        if (preview) URL.revokeObjectURL(preview.url);
        setPreview({
          url,
          mediaType: version.detected_media_type,
          title: `${version.category} · version ${version.version_number}`,
        });
      }
    } catch (retrieveError) {
      setPreviewError(retrieveError instanceof Error ? retrieveError.message : 'Could not retrieve this document.');
    }
  };

  const submitReview = async (versionId: string) => {
    setSavingReview(versionId);
    setReviewError(null);
    setSuccess(null);
    try {
      await apiRequest(`/api/admin/institution-documents/versions/${encodeURIComponent(versionId)}/reviews`, {
        method: 'POST',
        body: JSON.stringify({
          decisionCode: decisions[versionId] || undefined,
          remarks: remarks[versionId] || '',
        }),
      });
      setRemarks((current) => ({ ...current, [versionId]: '' }));
      setSuccess('Reviewer history entry saved.');
      await loadDocuments();
    } catch (saveError) {
      setReviewError(saveError instanceof Error ? saveError.message : 'Could not save reviewer remarks.');
    } finally {
      setSavingReview(null);
    }
  };

  const versionCard = (version: DocumentVersion, allowReview: boolean) => (
    <article key={version.version_id} className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          {allowReview && (
            <p className="text-sm font-bold text-slate-900">
              {version.institution_name} · {version.institution_login_id}
            </p>
          )}
          <p className="text-sm font-semibold text-slate-800">{version.category}</p>
          <p className="mt-1 text-xs text-slate-600">
            Version {version.version_number} · {version.detected_media_type} · {formatBytes(Number(version.file_size_bytes))}
          </p>
          <p className="text-xs text-slate-500">Uploaded {new Date(version.uploaded_at).toLocaleString()}</p>
        </div>
        {canOpenContent && <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void retrieve(version, 'preview')} className="rounded border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">
            Preview
          </button>
          <button type="button" onClick={() => void retrieve(version, 'download')} className="rounded border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">
            Download
          </button>
        </div>}
      </div>

      <div className="mt-3 border-t border-slate-100 pt-3">
        <h4 className="text-xs font-bold uppercase tracking-wide text-slate-600">Review history</h4>
        <p className="mt-1 text-xs text-slate-600">
          Review outcome: {version.reviews.find((review) => review.decision_code)?.decision_code || 'No decision recorded'}
        </p>
        {version.reviews.length > 0 ? (
          <ol className="mt-2 space-y-2">
            {version.reviews.map((review) => (
              <li key={review.id} className="rounded bg-slate-50 p-3 text-xs text-slate-700">
                <p className="font-semibold">
                  {review.reviewer_name} · {new Date(review.reviewed_at).toLocaleString()}
                  {review.decision_code ? ` · Configured decision: ${review.decision_code}` : ' · Remarks only'}
                </p>
                <p className="mt-1 whitespace-pre-wrap">{review.reviewer_remarks}</p>
              </li>
            ))}
          </ol>
        ) : <p className="mt-2 text-xs text-slate-500">No reviewer activity recorded.</p>}
      </div>

      {allowReview && canRecordReviews && (
        <form onSubmit={(event) => { event.preventDefault(); void submitReview(version.version_id); }} className="mt-3 space-y-2 border-t border-slate-100 pt-3">
          <label className="block text-xs font-semibold text-slate-700">
            Configured review decision
            <select
              value={decisions[version.version_id] || ''}
              onChange={(event) => setDecisions((current) => ({ ...current, [version.version_id]: event.target.value }))}
              disabled={!policy?.reviewDecisionCodes.length}
              className="mt-1 block w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm disabled:bg-slate-100"
            >
              <option value="">{policy?.reviewDecisionCodes.length ? 'Optional — select a configured decision' : 'Disabled pending decision-policy confirmation'}</option>
              {policy?.reviewDecisionCodes.map((code) => <option key={code} value={code}>{code}</option>)}
            </select>
          </label>
          <label className="block text-xs font-semibold text-slate-700">
            Reviewer remarks
            <textarea
              required
              minLength={1}
              maxLength={2000}
              rows={2}
              value={remarks[version.version_id] || ''}
              onChange={(event) => setRemarks((current) => ({ ...current, [version.version_id]: event.target.value }))}
              className="mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <button type="submit" disabled={savingReview === version.version_id} className="rounded bg-blue-900 px-3 py-2 text-xs font-bold text-white disabled:opacity-60">
            {savingReview === version.version_id ? 'Saving…' : 'Record remarks'}
          </button>
        </form>
      )}
    </article>
  );

  return (
    <section className="mt-5 space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:p-5" aria-labelledby={`institution-documents-${role}`}>
      <div>
        <h2 id={`institution-documents-${role}`} className="text-lg font-extrabold text-[#0B2E59]">
          {isOfficial ? 'Institution document review' : 'Institution documents'}
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Private documents are available only to the owning institution and authorized Officials.
        </p>
        {isOfficial && (!canOpenContent || !canRecordReviews) && (
          <p role="note" className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            {SUPER_ADMIN_ONLY_TEXT.institutionDocuments}
          </p>
        )}
      </div>

      {success && <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">{success}</p>}
      {uploadError && <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{uploadError}</p>}
      {reviewError && <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{reviewError}</p>}
      {previewError && <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{previewError}</p>}

      {policyLoading
        ? <p role="status" className="text-sm text-slate-600">Loading document policy…</p>
        : policyError
          ? <div role="alert" className="rounded-lg border border-rose-200 bg-white p-3 text-sm text-rose-800">
              <p>{policyError}</p>
              <button type="button" onClick={() => void loadPolicy()} className="mt-2 rounded border border-rose-300 px-3 py-1 font-semibold">Retry policy</button>
            </div>
          : null}

      {!isOfficial && (
        <div className="grid gap-3 sm:grid-cols-2">
          {INSTITUTION_DOCUMENT_CATEGORIES.map((category) => {
            const categoryDocuments = documentsByCategory.get(category) || [];
            const existing = new Set(categoryDocuments.map((version) => version.document_id));
            const latestVersionByDocument = new Set<string>();
            for (const version of categoryDocuments) {
              if (!latestVersionByDocument.has(version.document_id)) {
                latestVersionByDocument.add(version.document_id);
              }
            }
            const categoryAtLimit = policy?.maxDocumentsPerCategory !== null
              && policy?.maxDocumentsPerCategory !== undefined
              && existing.size >= policy.maxDocumentsPerCategory;
            return (
              <section key={category} className="rounded-lg border border-slate-200 bg-white p-4">
                <h3 className="font-bold text-slate-800">{category}</h3>
                <label className="mt-3 block text-xs font-semibold text-slate-600">
                  Upload document
                  <input
                    type="file"
                    accept={policy?.allowedMediaTypes.join(',')}
                    disabled={!policy?.uploadEnabled || categoryAtLimit || uploadingCategory !== null}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void handleUpload(file, category);
                      event.currentTarget.value = '';
                    }}
                    className="mt-1 block w-full text-sm file:mr-3 file:rounded file:border-0 file:bg-sky-50 file:px-3 file:py-2 file:font-semibold file:text-sky-800 disabled:opacity-50"
                  />
                </label>
                {!policy?.uploadEnabled && <p className="mt-2 text-xs text-amber-800">Uploads disabled until storage, file type, size, and category policies are configured.</p>}
                {policy?.maxDocumentsPerCategory && (
                  <p className="mt-1 text-xs text-slate-500">
                    Category documents: {existing.size} / {policy.maxDocumentsPerCategory}
                  </p>
                )}
                {categoryAtLimit && <p className="mt-2 text-xs text-slate-600">The configured category document limit is reached.</p>}
                {policy?.maxBytes && <p className="mt-1 text-xs text-slate-500">Configured size limit: {formatBytes(policy.maxBytes)}</p>}
                {uploadingCategory === category && (
                  <div className="mt-2" role="status" aria-live="polite">
                    <p className="text-xs text-sky-800">Uploading… {uploadProgress}%</p>
                    <progress className="mt-1 w-full" max={100} value={uploadProgress} />
                  </div>
                )}
                {categoryDocuments.map((version) => (
                  <div key={version.version_id} className="mt-3">
                    {versionCard(version, false)}
                    {policy?.replacementEnabled && latestVersionByDocument.has(version.version_id)
                      ? (
                        <label className="mt-2 block text-xs font-semibold text-slate-600">
                          Add replacement version
                          <input
                            type="file"
                            accept={policy.allowedMediaTypes.join(',')}
                            disabled={!policy.uploadEnabled || uploadingCategory !== null}
                            onChange={(event) => {
                              const file = event.target.files?.[0];
                              if (file) void handleUpload(file, category, version.document_id);
                              event.currentTarget.value = '';
                            }}
                            className="mt-1 block w-full text-sm disabled:opacity-50"
                          />
                        </label>
                      )
                      : null}
                  </div>
                ))}
              </section>
            );
          })}
        </div>
      )}

      {!isOfficial && !policy?.replacementEnabled && (
        <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">
          Version replacement is disabled pending confirmation of replacement eligibility rules.
        </p>
      )}

      {isOfficial && policy && policy.reviewDecisionCodes.length === 0 && (
        <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">
          Review decision controls remain disabled until the client confirms decision vocabulary and rules. Officials may record remarks without assigning an outcome.
        </p>
      )}

      {documentsLoading
        ? <p role="status" className="text-sm text-slate-600">Loading institution documents…</p>
        : documentsError
          ? <div role="alert" className="rounded-lg border border-rose-200 bg-white p-3 text-sm text-rose-800">
              <p>{documentsError}</p>
              <button type="button" onClick={() => void loadDocuments()} className="mt-2 rounded border border-rose-300 px-3 py-1 font-semibold">Retry documents</button>
            </div>
          : isOfficial
            ? <div className="space-y-3">
                {documents.map((version) => versionCard(version, true))}
                {documents.length === 0 && <p className="rounded-lg bg-white p-4 text-sm text-slate-600">No institution documents are available for review.</p>}
              </div>
            : null}

      <p className="text-xs text-slate-500">
        The server checks file signatures and policy limits. This foundation does not perform malware scanning or deep document sanitization.
      </p>

      {preview && (
        <div role="dialog" aria-modal="true" aria-label={preview.title} className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-3 sm:p-8">
          <section className="flex max-h-full w-full max-w-5xl flex-col rounded-xl bg-white p-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-bold text-slate-900">{preview.title}</h3>
              <button type="button" onClick={() => { URL.revokeObjectURL(preview.url); setPreview(null); }} className="rounded border border-slate-300 px-3 py-2 text-sm font-semibold">Close</button>
            </div>
            {preview.mediaType === 'application/pdf'
              ? <iframe title={preview.title} src={preview.url} sandbox="" className="mt-3 min-h-[65vh] w-full border border-slate-200" />
              : <img alt={preview.title} src={preview.url} className="mt-3 max-h-[75vh] max-w-full self-center object-contain" />}
          </section>
        </div>
      )}
    </section>
  );
};
