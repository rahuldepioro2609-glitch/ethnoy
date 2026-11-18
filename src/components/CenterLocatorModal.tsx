/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { X, MapPin, Search, ShieldCheck, Loader2 } from 'lucide-react';
import { apiRequest } from '../api';
import { useTranslation } from '../i18n';

interface CenterLocatorModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export interface ExamCenter {
  code: string;
  name: string;
  address: string;
}

export function filterCenters(centers: ExamCenter[], query: string): ExamCenter[] {
  const q = query.trim().toLowerCase();
  if (!q) return centers;
  return centers.filter((center) => [center.code, center.name, center.address].some((value) => value.toLowerCase().includes(q)));
}

/** Lists exam centres that appear on published admit cards. */
export const CenterLocatorModal: React.FC<CenterLocatorModalProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState('');
  const [centers, setCenters] = useState<ExamCenter[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoadError(null);
    apiRequest<{ centers: ExamCenter[] }>('/api/centers')
      .then(({ centers: list }) => { if (!cancelled) setCenters(list); })
      .catch((error: unknown) => { if (!cancelled) setLoadError(error instanceof Error ? error.message : t('centers.loadError')); });
    return () => { cancelled = true; };
  }, [isOpen, t]);

  if (!isOpen) return null;

  const filteredCenters = filterCenters(centers ?? [], searchQuery);

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="center-locator-title" className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/75 backdrop-blur-xs flex items-center justify-center p-3 sm:p-6 animate-in fade-in duration-150">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-4xl overflow-hidden my-6 flex flex-col">
        <div className="bg-[#0F172A] text-white px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-purple-500/20 text-purple-400 rounded-lg">
              <MapPin className="w-5 h-5" />
            </div>
            <div>
              <h2 id="center-locator-title" className="text-base font-bold leading-none">{t('centers.title')}</h2>
              <span className="text-xs text-slate-400">{t('centers.subtitle')}</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            aria-label={t('common.close')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 bg-slate-50 border-b border-slate-200">
          <label className="relative block">
            <span className="sr-only">{t('centers.searchPlaceholder')}</span>
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('centers.searchPlaceholder')}
              className="w-full pl-9 pr-4 py-2 bg-white border border-slate-300 rounded-xl text-xs font-medium focus:ring-2 focus:ring-purple-500 focus:outline-hidden"
            />
          </label>
        </div>

        <div className="p-6 overflow-y-auto max-h-[60vh] space-y-4">
          <div className="text-xs font-bold text-slate-500 uppercase tracking-wider flex flex-wrap items-center justify-between gap-2">
            <span>{t('centers.count', { count: filteredCenters.length })}</span>
            <span className="text-[11px] text-emerald-600 font-semibold flex items-center gap-1 normal-case tracking-normal">
              <ShieldCheck className="w-3.5 h-3.5" /> {t('centers.confirmOnAdmitCard')}
            </span>
          </div>

          {loadError && <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">{loadError}</p>}
          {!centers && !loadError && (
            <p className="flex items-center gap-2 py-8 justify-center text-xs text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> {t('common.loading')}</p>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filteredCenters.map((center) => (
              <div key={center.code} className="p-4 rounded-xl border border-slate-200 bg-white space-y-2">
                <span className="inline-block font-mono text-xs font-bold text-purple-700 bg-purple-50 px-2 py-0.5 rounded border border-purple-200">
                  {center.code}
                </span>
                <h3 className="text-sm font-bold text-slate-900 leading-snug">{center.name}</h3>
                <div className="text-xs text-slate-600 flex items-start gap-1.5">
                  <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
                  <span>{center.address}</span>
                </div>
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${center.name}, ${center.address}`)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-block text-xs font-semibold text-blue-800 underline"
                >
                  {t('centers.openMap')}
                </a>
              </div>
            ))}
          </div>

          {centers && filteredCenters.length === 0 && (
            <div className="py-12 text-center text-slate-500 text-xs">
              {centers.length ? t('centers.none') : t('centers.noneYet')}
            </div>
          )}
        </div>

        <div className="p-4 bg-slate-50 border-t border-slate-200 flex items-center justify-between gap-3 text-xs text-slate-600">
          <span>{t('centers.reportingNote')}</span>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-bold transition-colors"
          >
            {t('common.closeButton')}
          </button>
        </div>
      </div>
    </div>
  );
};
