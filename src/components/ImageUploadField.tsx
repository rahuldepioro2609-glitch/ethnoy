import React, { useEffect, useId, useState } from 'react';
import { CheckCircle2, ImagePlus, Loader2 } from 'lucide-react';
import { formatBytes, prepareImage, uploadFile, type UploadedFile } from '../utils/fileUpload';
import { useTranslation } from '../i18n';

interface ImageUploadFieldProps {
  kind: 'photo' | 'signature';
  label: string;
  hint: string;
  value: UploadedFile | null;
  onChange: (file: UploadedFile | null) => void;
}

/** Picks an image, compresses it in the browser, uploads it, and shows a preview. */
export const ImageUploadField: React.FC<ImageUploadFieldProps> = ({ kind, label, hint, value, onChange }) => {
  const { t } = useTranslation();
  const inputId = useId();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setIsUploading(true);
    try {
      const prepared = await prepareImage(file, kind);
      const uploaded = await uploadFile(kind, prepared, file.name);
      setPreviewUrl(URL.createObjectURL(prepared));
      onChange(uploaded);
    } catch (uploadError) {
      onChange(null);
      setError(uploadError instanceof Error ? t(uploadError.message) : t('upload.failed'));
    } finally {
      setIsUploading(false);
    }
  };

  const isPhoto = kind === 'photo';
  return (
    <div>
      <span className="block font-bold text-slate-700 uppercase tracking-wider mb-1">{label}</span>
      <label
        htmlFor={inputId}
        className={`flex items-center gap-3 rounded-xl border-2 border-dashed p-3 cursor-pointer transition-colors ${
          value ? 'border-emerald-400 bg-emerald-50/50' : 'border-slate-300 bg-slate-50 hover:border-emerald-500'
        }`}
      >
        <div className={`${isPhoto ? 'h-20 w-16' : 'h-12 w-28'} shrink-0 overflow-hidden rounded border border-slate-200 bg-white flex items-center justify-center`}>
          {previewUrl && value
            ? <img src={previewUrl} alt={t('upload.previewAlt', { label })} className="h-full w-full object-contain" />
            : <ImagePlus className="h-5 w-5 text-slate-400" />}
        </div>
        <div className="min-w-0 text-[11px]">
          {isUploading ? (
            <span className="flex items-center gap-1.5 font-semibold text-slate-700"><Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('upload.uploading')}</span>
          ) : value ? (
            <span className="flex items-center gap-1.5 font-bold text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" /> {t('upload.done', { size: formatBytes(value.sizeBytes) })}</span>
          ) : (
            <span className="font-semibold text-slate-700">{t('upload.choose')}</span>
          )}
          <span className="mt-0.5 block text-slate-500">{hint}</span>
        </div>
        <input
          id={inputId}
          type="file"
          accept="image/jpeg,image/png"
          className="sr-only"
          disabled={isUploading}
          onChange={(event) => {
            void handleFile(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
      </label>
      {error && <p role="alert" className="mt-1 text-[11px] font-semibold text-rose-700">{error}</p>}
    </div>
  );
};
