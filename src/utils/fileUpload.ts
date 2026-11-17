import { ApiError } from '../api';

export type UploadKind = 'photo' | 'signature' | 'objection_document';

export interface UploadedFile {
  id: string;
  kind: UploadKind;
  mimeType: string;
  originalName: string | null;
  sizeBytes: number;
}

/** Client-side targets. Kept below the server limits in server/fileRules.ts. */
export const IMAGE_TARGETS: Record<'photo' | 'signature', { maxWidth: number; maxHeight: number; maxBytes: number }> = {
  photo: { maxWidth: 360, maxHeight: 480, maxBytes: 280 * 1024 },
  signature: { maxWidth: 600, maxHeight: 200, maxBytes: 140 * 1024 },
};

export const OBJECTION_DOCUMENT_MAX_BYTES = 2 * 1024 * 1024;

/** Scales width/height down (never up) so both fit inside the limits, keeping the aspect ratio. */
export function fitWithin(width: number, height: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not process this image.'))), 'image/jpeg', quality);
  });
}

/** Resizes and re-encodes an image as JPEG until it fits the target size. */
export async function prepareImage(file: File, kind: 'photo' | 'signature'): Promise<Blob> {
  if (!['image/jpeg', 'image/png'].includes(file.type)) {
    throw new Error('Choose a JPG or PNG image.');
  }
  const target = IMAGE_TARGETS[kind];
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('This image could not be read. Try a different JPG or PNG file.');
  }
  let { width, height } = fitWithin(bitmap.width, bitmap.height, target.maxWidth, target.maxHeight);
  const canvas = document.createElement('canvas');
  try {
    for (let pass = 0; pass < 4; pass += 1) {
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Image processing is not supported in this browser.');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
      for (const quality of [0.9, 0.8, 0.7, 0.6, 0.5]) {
        const blob = await canvasToBlob(canvas, quality);
        if (blob.size <= target.maxBytes) return blob;
      }
      width = Math.round(width * 0.75);
      height = Math.round(height * 0.75);
    }
  } finally {
    bitmap.close();
  }
  throw new Error('This image is too detailed to compress. Try a simpler photo.');
}

export async function uploadFile(kind: UploadKind, body: Blob, fileName: string): Promise<UploadedFile> {
  const response = await fetch(`/api/uploads/${kind}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': body.type || 'application/octet-stream',
      'X-File-Name': encodeURIComponent(fileName),
    },
    body,
  });
  const payload = await response.json().catch(() => ({})) as { file?: UploadedFile; error?: string };
  if (!response.ok || !payload.file) {
    throw new ApiError(payload.error ?? `Upload failed (${response.status}).`, response.status);
  }
  return payload.file;
}
