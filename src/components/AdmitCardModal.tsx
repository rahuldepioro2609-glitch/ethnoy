/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { useEscapeKey } from './useEscapeKey';
import { X, Printer, Download, CheckCircle2, AlertTriangle, ShieldCheck, QrCode, FileText } from 'lucide-react';
import {
  validateAdmitCardLookup,
  CandidateAdmitCardData,
} from '../utils/examLogic';
import { apiRequest } from '../api';
import { useTranslation } from '../i18n';

interface AdmitCardModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultExamCode?: string;
}

export const AdmitCardModal: React.FC<AdmitCardModalProps> = ({ isOpen, onClose, defaultExamCode = '' }) => {
  useEscapeKey(isOpen, onClose);
  const { t } = useTranslation();
  const [publishedExams, setPublishedExams] = useState<Array<{ code: string; name: string }>>([]);
  const [appNumber, setAppNumber] = useState('');
  const [dob, setDob] = useState('');
  const [examCode, setExamCode] = useState(defaultExamCode);
  const [admitCard, setAdmitCard] = useState<CandidateAdmitCardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    apiRequest<{ exams: Array<{ code: string; name: string }> }>('/api/exams')
      .then(({ exams }) => {
        setPublishedExams(exams);
        setExamCode((current) => current || exams[0]?.code || '');
      })
      .catch(() => setPublishedExams([]));
  }, [isOpen]);

  if (!isOpen) return null;

  const handleLookup = async (e: React.FormEvent) => {
    e.preventDefault();
    const val = validateAdmitCardLookup(appNumber, dob);
    if (!val.isValid) {
      setError(val.error || t('admit.fillAll'));
      return;
    }
    setError(null);
    setIsLoading(true);
    try {
      const { admitCard: card } = await apiRequest<{ admitCard: CandidateAdmitCardData }>('/api/admit-cards/lookup', {
        method: 'POST',
        body: JSON.stringify({
          applicationNumber: appNumber.trim(),
          dateOfBirth: dob,
          examCode,
        }),
      });
      setAdmitCard(card);
    } catch (lookupError) {
      setError(lookupError instanceof Error ? lookupError.message : t('admit.loadError'));
    } finally {
      setIsLoading(false);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  const handleReset = () => {
    setAdmitCard(null);
    setError(null);
  };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="admit-card-title" className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/70 backdrop-blur-xs flex items-center justify-center p-3 sm:p-6 animate-in fade-in duration-150">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-4xl overflow-hidden my-6">
        {/* Modal Top Bar */}
        <div className="bg-[#0F172A] text-white px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-emerald-500/20 text-emerald-400 rounded-lg">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <h2 id="admit-card-title" className="text-base font-bold leading-none">
                {t('admit.title')}
              </h2>
              <span className="text-xs text-slate-400">
                {t('admit.subtitle')}
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            aria-label={t('admit.close')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Area */}
        <div className="p-6">
          {!admitCard ? (
            /* Search Form */
            <div className="max-w-xl mx-auto space-y-6">
              <div className="bg-blue-50/70 border border-blue-200 rounded-xl p-4 text-xs text-blue-900 flex items-start gap-3">
                <ShieldCheck className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
                <div>
                  <span className="font-bold">{t('admit.instructionsTitle')}</span> {t('admit.instructions')}
                </div>
              </div>

              <form onSubmit={handleLookup} className="space-y-4">
                <div>
                  <label htmlFor="admit-exam-select" className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                    {t('admit.exam')}
                  </label>
                  <input
                    id="admit-exam-select"
                    list="admit-exam-options"
                    required
                    value={examCode}
                    onChange={(e) => setExamCode(e.target.value.toUpperCase())}
                    placeholder={t('admit.examPlaceholder')}
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-sm font-mono font-bold uppercase focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                  />
                  <datalist id="admit-exam-options">
                    {publishedExams.map((exam) => <option key={exam.code} value={exam.code}>{exam.name}</option>)}
                  </datalist>
                  <p className="mt-1 text-[11px] text-slate-500">{t('admit.examHint')}</p>
                </div>

                <div>
                  <label htmlFor="admit-app-no" className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                    {t('admit.appNumber')}
                  </label>
                  <input
                    id="admit-app-no"
                    type="text"
                    value={appNumber}
                    onChange={(e) => setAppNumber(e.target.value)}
                    placeholder={t('admit.appNumberPlaceholder')}
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-sm font-mono font-bold tracking-wide focus:ring-2 focus:ring-emerald-500 focus:outline-hidden uppercase"
                    required
                  />
                </div>

                <div>
                  <label htmlFor="admit-dob" className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5">
                    {t('admit.dob')}
                  </label>
                  <input
                    id="admit-dob"
                    type="date"
                    value={dob}
                    onChange={(e) => setDob(e.target.value)}
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-sm font-medium focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                    required
                  />
                </div>

                {error && (
                  <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}

                <div className="pt-2 flex items-center gap-3">
                  <button
                    type="submit"
                    disabled={isLoading}
                    className="flex-1 py-3 px-4 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm rounded-xl shadow-md transition-all flex items-center justify-center gap-2"
                  >
                    <FileText className="w-4 h-4" />
                    <span>{isLoading ? t('admit.checking') : t('admit.view')}</span>
                  </button>
                </div>
              </form>
            </div>
          ) : (
            /* Printable Hall Ticket Document */
            <div className="space-y-6">
              {/* Action Toolbar */}
              <div className="flex flex-wrap items-center justify-between gap-3 p-3 bg-slate-100 rounded-xl border border-slate-200">
                <div className="flex items-center gap-2 text-xs text-emerald-800 font-bold bg-emerald-100 px-3 py-1.5 rounded-lg">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  <span>{t('admit.found')}</span>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={handleReset}
                    className="px-3 py-1.5 bg-white hover:bg-slate-50 text-slate-700 border border-slate-300 rounded-lg text-xs font-semibold transition-colors"
                  >
                    {t('admit.newSearch')}
                  </button>
                  <button
                    onClick={handlePrint}
                    className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors shadow-xs"
                  >
                    <Printer className="w-4 h-4" />
                    <span>{t('admit.print')}</span>
                  </button>
                </div>
              </div>

              {/* The Hall Ticket Paper */}
              <div
                id="printable-admit-card"
                className="bg-white border-2 border-slate-800 p-6 sm:p-8 rounded-xl shadow-md space-y-6 text-slate-900 font-sans"
              >
                {/* Header */}
                <div className="border-b-2 border-slate-800 pb-4 flex flex-col sm:flex-row items-center justify-between gap-4 text-center sm:text-left">
                  <div className="flex items-center gap-3">
                    <img src="/assets/eltnoy-logo.png" alt="" className="w-14 h-14 rounded-lg object-contain border border-slate-200" />
                    <div>
                      <div className="text-base font-extrabold text-slate-900 uppercase tracking-tight">
                        {t('admit.cardIssuer')}
                      </div>
                      <div className="text-[11px] font-mono text-slate-500 uppercase">
                        {t('admit.cardTitle')}
                      </div>
                    </div>
                  </div>

                  {/* QR Hologram Stamp */}
                  <div className="p-2 border border-slate-300 rounded-lg bg-slate-50 text-center flex flex-col items-center">
                    <QrCode className="w-12 h-12 text-slate-800" />
                    <span className="text-[9px] font-mono font-bold text-slate-600 mt-1">
                      {admitCard.rollNumber}
                    </span>
                  </div>
                </div>

                {/* Exam Name Banner */}
                <div className="bg-slate-900 text-white p-2.5 text-center rounded-md font-bold text-xs uppercase tracking-wider">
                  {admitCard.examName}
                </div>

                {/* Candidate & Roll Details Grid */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4 border border-slate-300 p-4 rounded-lg bg-slate-50/50 text-xs">
                  <div className="md:col-span-3 grid grid-cols-2 sm:grid-cols-3 gap-y-3 gap-x-4">
                    <div>
                      <span className="text-slate-500 font-medium block">{t('admit.rollNumber')}</span>
                      <strong className="text-slate-900 font-mono text-sm">{admitCard.rollNumber}</strong>
                    </div>
                    <div>
                      <span className="text-slate-500 font-medium block">{t('admit.applicationNo')}</span>
                      <strong className="text-slate-900 font-mono">{admitCard.applicationNumber}</strong>
                    </div>
                    <div>
                      <span className="text-slate-500 font-medium block">{t('admit.candidateName')}</span>
                      <strong className="text-slate-900 uppercase">{admitCard.candidateName}</strong>
                    </div>
                    <div>
                      <span className="text-slate-500 font-medium block">{t('admit.fatherName')}</span>
                      <strong className="text-slate-900 uppercase">{admitCard.fatherName}</strong>
                    </div>
                    <div>
                      <span className="text-slate-500 font-medium block">{t('admit.dobShort')}</span>
                      <strong className="text-slate-900">{admitCard.dob}</strong>
                    </div>
                    <div>
                      <span className="text-slate-500 font-medium block">{t('admit.categoryGender')}</span>
                      <strong className="text-slate-900">{admitCard.category} / {t(`admit.gender.${admitCard.gender}`)}</strong>
                    </div>
                  </div>

                  {/* Candidate Photo Placeholder box */}
                  <div className="flex flex-col items-center justify-center border-2 border-dashed border-slate-300 rounded-lg p-2 bg-white">
                    {admitCard.photoUrl ? (
                      <img src={admitCard.photoUrl} alt={t('admit.photoAlt')} className="w-20 h-24 rounded object-cover border border-slate-200" />
                    ) : (
                      <div className="w-20 h-24 bg-slate-200 rounded flex items-center justify-center text-slate-500 text-center text-[10px] p-1 font-bold">
                        {t('admit.pastePhoto')}
                      </div>
                    )}
                    {admitCard.signatureUrl ? (
                      <img src={admitCard.signatureUrl} alt={t('admit.signatureAlt')} className="mt-1 h-8 w-24 object-contain" />
                    ) : (
                      <span className="h-8 w-24 border-b border-slate-400" aria-hidden="true" />
                    )}
                    <span className="text-[10px] text-slate-500 font-mono mt-1">{t('admit.candidateSign')}</span>
                  </div>
                </div>

                {/* Test Timing & Center Allotment */}
                <div className="border border-slate-300 rounded-lg overflow-hidden text-xs">
                  <div className="bg-slate-200/80 px-4 py-2 font-bold text-slate-800 uppercase tracking-wide">
                    {t('admit.schedule')}
                  </div>
                  <div className="p-4 grid grid-cols-1 sm:grid-cols-3 gap-4 bg-white border-b border-slate-200">
                    <div>
                      <span className="text-slate-500 block">{t('admit.examDate')}</span>
                      <strong className="text-slate-900 text-sm">{admitCard.examDate}</strong>
                    </div>
                    <div>
                      <span className="text-slate-500 block">{t('admit.reporting')}</span>
                      <strong className="text-emerald-700 text-sm">{admitCard.reportingTime}</strong>
                      <span className="text-[10px] text-rose-600 block">{t('admit.gateCloses', { time: admitCard.gateClosingTime })}</span>
                    </div>
                    <div>
                      <span className="text-slate-500 block">{t('admit.timing')}</span>
                      <strong className="text-slate-900">{admitCard.examTiming}</strong>
                    </div>
                  </div>
                  <div className="p-4 bg-slate-50">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-slate-500">{t('admit.centerCode')}</span>
                      <strong className="font-mono text-blue-700 bg-blue-50 px-2 py-0.5 rounded border border-blue-200">
                        {admitCard.centerCode}
                      </strong>
                    </div>
                    <div className="font-bold text-slate-900">{admitCard.centerName}</div>
                    <div className="text-slate-600 text-[11px] mt-0.5">{admitCard.centerAddress}</div>
                  </div>
                </div>

                {/* Key Instructions */}
                <div className="text-[11px] space-y-1 text-slate-600 border-t border-slate-200 pt-3">
                  <div className="font-bold text-slate-800 uppercase">{t('admit.advisory')}</div>
                  <ol className="list-decimal pl-4 space-y-0.5">
                    <li>{t('admit.advice1')}</li>
                    <li>{t('admit.advice2', { time: admitCard.gateClosingTime })}</li>
                    <li>{t('admit.advice3')}</li>
                  </ol>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
