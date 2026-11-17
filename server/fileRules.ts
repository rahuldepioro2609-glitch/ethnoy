export type UploadKind = 'photo' | 'signature' | 'objection_document';
export type UploadMimeType = 'image/jpeg' | 'image/png' | 'application/pdf';

export const UPLOAD_RULES: Record<UploadKind, { maxBytes: number; mimeTypes: UploadMimeType[]; label: string }> = {
  photo: { maxBytes: 300 * 1024, mimeTypes: ['image/jpeg', 'image/png'], label: 'Photograph' },
  signature: { maxBytes: 150 * 1024, mimeTypes: ['image/jpeg', 'image/png'], label: 'Signature' },
  objection_document: { maxBytes: 2 * 1024 * 1024, mimeTypes: ['image/jpeg', 'image/png', 'application/pdf'], label: 'Supporting document' },
};

export const MAX_FILES_PER_USER = 60;

export function isUploadKind(value: unknown): value is UploadKind {
  return typeof value === 'string' && Object.hasOwn(UPLOAD_RULES, value);
}

/** Identifies a file from its leading bytes, ignoring the client-supplied type. */
export function detectMimeType(data: Uint8Array): UploadMimeType | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (
    data.length >= 8
    && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a
  ) return 'image/png';
  if (data.length >= 5 && String.fromCharCode(...data.subarray(0, 5)) === '%PDF-') return 'application/pdf';
  return null;
}

export function validateUpload(kind: UploadKind, data: Uint8Array): { mimeType: UploadMimeType } | { error: string } {
  const rule = UPLOAD_RULES[kind];
  if (!data.length) return { error: `${rule.label} file is empty.` };
  if (data.length > rule.maxBytes) {
    return { error: `${rule.label} must be ${Math.round(rule.maxBytes / 1024)} KB or smaller.` };
  }
  const mimeType = detectMimeType(data);
  if (!mimeType || !rule.mimeTypes.includes(mimeType)) {
    const allowed = rule.mimeTypes.map((type) => type.split('/')[1].toUpperCase()).join(', ');
    return { error: `${rule.label} must be a ${allowed} file.` };
  }
  return { mimeType };
}

/** Keeps a display-only file name: no path parts, control characters, or excessive length. */
export function sanitizeFileName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Use the raw header value when it is not URI-encoded.
  }
  const name = decoded.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f"]/g, '').trim() ?? '';
  return name ? name.slice(0, 120) : null;
}
