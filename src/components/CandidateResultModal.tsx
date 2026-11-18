/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { useEscapeKey } from './useEscapeKey';
import {
  X,
  Award,
  Search,
  Printer,
  CheckCircle2,
  AlertTriangle,
  QrCode,
  ShieldCheck,
  Calendar,
  FileText,
  TrendingUp,
  User,
  GraduationCap,
  Sparkles,
} from 'lucide-react';
import {
  performanceBand,
  formatRankDisplay,
  getCutoffComparison,
  CandidateScorecard,
} from '../utils/resultLogic';
import { apiRequest } from '../api';

import { useTranslation } from '../i18n';
interface CandidateResultModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultRollNumber?: string;
}

export const CandidateResultModal: React.FC<CandidateResultModalProps> = ({
  isOpen,
  onClose,
  defaultRollNumber = '',
}) => {
  useEscapeKey(isOpen, onClose);
  const [rollInput, setRollInput] = useState(defaultRollNumber);
  const [dobInput, setDobInput] = useState('');
  const { t } = useTranslation();
  const [selectedExam, setSelectedExam] = useState('');
  const [publishedExams, setPublishedExams] = useState<Array<{ code: string; name: string }>>([]);
  const [activeScorecard, setActiveScorecard] = useState<CandidateScorecard | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [isPrinting, setIsPrinting] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    apiRequest<{ exams: Array<{ code: string; name: string }> }>('/api/exams')
      .then(({ exams }) => {
        setPublishedExams(exams);
        setSelectedExam((current) => current || exams[0]?.code || '');
      })
      .catch(() => setPublishedExams([]));
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!rollInput.trim() || !dobInput || !selectedExam.trim()) {
      setLookupError(t('result.fillAll'));
      return;
    }
    setLookupError(null);
    setIsSearching(true);
    setActiveScorecard(null);
    setHasSearched(true);
    try {
      const { scorecard } = await apiRequest<{ scorecard: CandidateScorecard }>('/api/results/lookup', {
        method: 'POST',
        body: JSON.stringify({
          identifier: rollInput.trim(),
          dateOfBirth: dobInput,
          examCode: selectedExam.trim(),
        }),
      });
      setActiveScorecard(scorecard);
    } catch (error) {
      setLookupError(error instanceof Error ? error.message : t('result.loadError'));
    } finally {
      setIsSearching(false);
    }
  };

  const handlePrint = () => {
    setIsPrinting(true);
    setTimeout(() => {
      window.print();
      setIsPrinting(false);
    }, 200);
  };

  const cutoffComp = activeScorecard ? getCutoffComparison(activeScorecard) : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="result-modal-title"
      className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/75 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5"
    >
      <div className="bg-white rounded-2xl shadow-2xl max-w-4xl w-full border border-slate-200 overflow-hidden flex flex-col max-h-[92vh] animate-in fade-in zoom-in-95 duration-150">
        {/* Header Bar */}
        <div className="bg-[#0B254E] text-white px-6 py-4 flex items-center justify-between border-b border-sky-900">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/20 border border-emerald-400/30 flex items-center justify-center text-emerald-400">
              <Award className="w-6 h-6 stroke-[2.2]" />
            </div>
            <div>
              <h2 id="result-modal-title" className="text-lg font-bold tracking-tight">
                {t('result.title')}
              </h2>
              <p className="text-xs text-sky-200">
                {t('result.subtitle')}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-white/10 transition-colors"
            aria-label={t('result.close')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Verification Form Strip */}
        <div className="bg-slate-50 border-b border-slate-200 p-4 sm:p-5">
          <form onSubmit={handleSearch} className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
            <div className="sm:col-span-4">
              <label htmlFor="res-roll" className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
                {t('result.idLabel')}
              </label>
              <input
                id="res-roll"
                type="text"
                value={rollInput}
                onChange={(e) => setRollInput(e.target.value)}
                placeholder={t('result.idPlaceholder')}
                className="w-full text-xs font-semibold px-3 py-2 bg-white border border-slate-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-[#16A34A] focus:border-transparent uppercase"
              />
            </div>

            <div className="sm:col-span-3">
              <label htmlFor="res-dob" className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
                {t('result.dob')}
              </label>
              <input
                id="res-dob"
                type="date"
                value={dobInput}
                onChange={(e) => setDobInput(e.target.value)}
                className="w-full text-xs font-medium px-3 py-2 bg-white border border-slate-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-[#16A34A] focus:border-transparent"
              />
            </div>

            <div className="sm:col-span-3">
              <label htmlFor="res-exam" className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
                {t('result.exam')}
              </label>
              <input
                id="res-exam"
                list="res-exam-options"
                value={selectedExam}
                onChange={(e) => setSelectedExam(e.target.value.toUpperCase())}
                placeholder={t('admit.examPlaceholder')}
                className="w-full text-xs font-mono font-semibold uppercase px-3 py-2 bg-white border border-slate-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-[#16A34A] focus:border-transparent"
              />
              <datalist id="res-exam-options">
                {publishedExams.map((exam) => <option key={exam.code} value={exam.code}>{exam.name}</option>)}
              </datalist>
            </div>

            <div className="sm:col-span-2">
              <button
                type="submit"
                disabled={isSearching}
                className="w-full py-2 px-3 bg-[#16A34A] hover:bg-[#15803D] disabled:opacity-60 text-white text-xs font-bold rounded-lg transition-colors flex items-center justify-center gap-1.5 shadow-xs"
              >
                <Search className="w-3.5 h-3.5" />
                <span>{isSearching ? t('result.searching') : t('result.search')}</span>
              </button>
            </div>
          </form>

          <div className="mt-3 text-xs">
            {lookupError ? (
              <p role="alert" className="text-rose-700">{lookupError}</p>
            ) : (
              <p className="text-slate-500">{t('result.hint')}</p>
            )}
          </div>
        </div>

        {/* Scorecard Body */}
        <div className="overflow-y-auto p-5 sm:p-6 space-y-6 flex-1">
          {activeScorecard && hasSearched ? (
            <div id="printable-scorecard" className="border border-slate-300 rounded-xl bg-white p-6 shadow-xs relative">
              {/* Official Seal / Watermark Header */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-slate-200 gap-4">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-xl bg-emerald-50 border border-emerald-200 flex items-center justify-center">
                    <GraduationCap className="w-7 h-7 text-[#15803D]" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-black uppercase tracking-wider text-slate-500">{t('result.scorecard')}</span>
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800">
                        <ShieldCheck className="w-3 h-3 text-emerald-600" />
                        {t('result.publishedBadge')}
                      </span>
                    </div>
                    <h3 className="text-lg font-black text-[#0B254E] tracking-tight">{activeScorecard.examName}</h3>
                    <div className="text-xs text-slate-500">
                      {t('result.dates', { examDate: activeScorecard.examDate, issueDate: activeScorecard.issueDate })}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-3 self-end sm:self-auto">
                  <div className="text-right hidden sm:block">
                    <div className="text-[11px] font-mono text-slate-400">{t('result.verificationCode')}</div>
                    <div className="text-xs font-bold font-mono text-slate-700">{activeScorecard.digitalVerificationCode}</div>
                  </div>
                  <div className="p-1.5 border border-slate-300 rounded-lg bg-slate-50">
                    <QrCode className="w-12 h-12 text-slate-800" />
                  </div>
                </div>
              </div>

              {/* Candidate Info Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 py-4 border-b border-slate-200 text-xs">
                <div>
                  <span className="text-slate-400 font-medium block">{t('result.candidateName')}</span>
                  <span className="font-bold text-slate-900 text-sm">{activeScorecard.candidateName}</span>
                </div>
                <div>
                  <span className="text-slate-400 font-medium block">{t('result.rollNumber')}</span>
                  <span className="font-bold font-mono text-slate-900">{activeScorecard.rollNumber}</span>
                </div>
                <div>
                  <span className="text-slate-400 font-medium block">{t('result.applicationNo')}</span>
                  <span className="font-bold font-mono text-slate-900">{activeScorecard.applicationNumber}</span>
                </div>
                <div>
                  <span className="text-slate-400 font-medium block">{t('result.categoryPwd')}</span>
                  <span className="font-bold text-slate-900">{activeScorecard.category} {activeScorecard.pwdStatus ? t('result.pwd') : ''}</span>
                </div>

                <div>
                  <span className="text-slate-400 font-medium block">{t('result.fatherName')}</span>
                  <span className="font-semibold text-slate-800">{activeScorecard.fatherName}</span>
                </div>
                <div>
                  <span className="text-slate-400 font-medium block">{t('result.motherName')}</span>
                  <span className="font-semibold text-slate-800">{activeScorecard.motherName}</span>
                </div>
                <div>
                  <span className="text-slate-400 font-medium block">{t('result.dob')}</span>
                  <span className="font-semibold text-slate-800">{activeScorecard.dob}</span>
                </div>
                <div>
                  <span className="text-slate-400 font-medium block">{t('result.center')}</span>
                  <span className="font-semibold text-slate-800 truncate block" title={activeScorecard.centerName}>
                    {activeScorecard.centerName}
                  </span>
                </div>
              </div>

              {/* High Impact Highlights: AIR, Category Rank, Percentile, Qualification Status */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 py-4">
                <div className="bg-sky-50 border border-sky-100 rounded-xl p-3 text-center">
                  <div className="text-[11px] font-bold text-sky-700 uppercase tracking-wider">{t('result.air')}</div>
                  <div className="text-2xl font-black text-[#0B254E] mt-0.5">
                    {formatRankDisplay(activeScorecard.allIndiaRank, '')}
                  </div>
                  <div className="text-[10px] text-sky-600 font-semibold mt-1 flex items-center justify-center gap-1">
                    <TrendingUp className="w-3 h-3" /> {t('result.percentileOf', { value: activeScorecard.aggregatePercentile })}
                  </div>
                </div>

                <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-3 text-center">
                  <div className="text-[11px] font-bold text-emerald-800 uppercase tracking-wider">{t('result.categoryRank')}</div>
                  <div className="text-2xl font-black text-emerald-700 mt-0.5">
                    {formatRankDisplay(activeScorecard.categoryRank, '')}
                  </div>
                  <div className="text-[10px] text-emerald-600 font-medium mt-1">
                    {t('result.categoryValue', { category: activeScorecard.category })}
                  </div>
                </div>

                <div className="bg-purple-50 border border-purple-100 rounded-xl p-3 text-center">
                  <div className="text-[11px] font-bold text-purple-800 uppercase tracking-wider">{t('result.percentile')}</div>
                  <div className="text-2xl font-black text-purple-700 mt-0.5">
                    {activeScorecard.aggregatePercentile}%
                  </div>
                  <div className="text-[10px] text-purple-600 font-medium mt-1">
                    {t('result.aggregate')}
                  </div>
                </div>

                <div className="bg-amber-50 border border-amber-100 rounded-xl p-3 text-center">
                  <div className="text-[11px] font-bold text-amber-800 uppercase tracking-wider">{t('result.status')}</div>
                  {activeScorecard.qualifyingStatus === 'QUALIFIED' ? (
                    <div className="text-sm font-black text-emerald-700 mt-1 flex items-center justify-center gap-1">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                      <span>{t('result.qualified')}</span>
                    </div>
                  ) : (
                    <div className="text-sm font-black text-rose-700 mt-1 flex items-center justify-center gap-1">
                      <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                      <span>{t('result.notQualified')}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Sectional Score Breakdown Table */}
              <div className="mt-2">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
                    <FileText className="w-4 h-4 text-emerald-600" />
                    {t('result.sections')}
                  </h4>
                </div>

                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="w-full text-xs text-left">
                    <thead className="bg-slate-100 text-slate-700 font-bold uppercase tracking-wider text-[11px]">
                      <tr>
                        <th className="py-2.5 px-3">{t('result.section')}</th>
                        <th className="py-2.5 px-3 text-center">{t('result.maxMarks')}</th>
                        <th className="py-2.5 px-3 text-center">{t('result.marksObtained')}</th>
                        <th className="py-2.5 px-3 text-center">{t('result.sectionPercentile')}</th>
                        <th className="py-2.5 px-3 text-center">{t('result.performance')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {activeScorecard.sectionScores.map((sec, idx) => (
                        <tr key={idx} className="hover:bg-slate-50">
                          <td className="py-2.5 px-3 font-semibold text-slate-800">{sec.sectionName}</td>
                          <td className="py-2.5 px-3 text-center font-mono text-slate-600">{sec.maxMarks}</td>
                          <td className="py-2.5 px-3 text-center font-mono font-bold text-[#16A34A]">{sec.marksObtained}</td>
                          <td className="py-2.5 px-3 text-center font-mono font-semibold text-slate-700">{sec.percentile}%</td>
                          <td className="py-2.5 px-3 text-center">
                            <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold ${{
                              excellent: 'bg-emerald-100 text-emerald-800',
                              good: 'bg-sky-100 text-sky-800',
                              average: 'bg-amber-100 text-amber-800',
                              needsImprovement: 'bg-rose-100 text-rose-800',
                            }[performanceBand(sec.marksObtained, sec.maxMarks)]}`}>
                              {t(`result.band.${performanceBand(sec.marksObtained, sec.maxMarks)}`)}
                            </span>
                          </td>
                        </tr>
                      ))}
                      <tr className="bg-slate-100 font-bold text-slate-900">
                        <td className="py-3 px-3">{t('result.total')}</td>
                        <td className="py-3 px-3 text-center font-mono">{activeScorecard.totalMaxMarks}</td>
                        <td className="py-3 px-3 text-center font-mono text-base text-[#15803D]">
                          {activeScorecard.totalMarksObtained}
                        </td>
                        <td className="py-3 px-3 text-center font-mono text-base text-[#0B254E]">
                          {activeScorecard.aggregatePercentile}%
                        </td>
                        <td className="py-3 px-3 text-center text-xs text-slate-600">{t(`result.band.${performanceBand(activeScorecard.totalMarksObtained, activeScorecard.totalMaxMarks)}`)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Cut-off Analysis & Counseling Stream Box */}
              <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="p-4 rounded-xl border border-slate-200 bg-slate-50 text-xs space-y-2">
                  <div className="font-bold text-slate-800 flex items-center justify-between">
                    <span>{t('result.cutoffTitle')}</span>
                    <span className="text-emerald-700 font-bold">
                      {t('result.cutoff', { marks: cutoffComp?.categoryCutoff ?? '' })}
                    </span>
                  </div>
                  <div className="w-full bg-slate-200 h-2.5 rounded-full overflow-hidden">
                    <div
                      className="bg-[#16A34A] h-full rounded-full transition-all duration-500"
                      style={{
                        width: `${Math.min(
                          100,
                          (activeScorecard.totalMarksObtained / activeScorecard.totalMaxMarks) * 100
                        )}%`,
                      }}
                    />
                  </div>
                  <div className="flex justify-between text-[11px] text-slate-500">
                    <span>{t('result.yourMarks', { marks: activeScorecard.totalMarksObtained })}</span>
                    <span className={`font-semibold ${cutoffComp?.hasCleared ? 'text-emerald-700' : 'text-rose-700'}`}>
                      {cutoffComp?.hasCleared
                        ? t('result.aboveCutoff', { margin: cutoffComp.margin, category: activeScorecard.category })
                        : t('result.belowCutoff', { margin: Math.abs(cutoffComp?.margin ?? 0), category: activeScorecard.category })}
                    </span>
                  </div>
                </div>

                <div className="p-4 rounded-xl border border-emerald-200 bg-emerald-50/60 text-xs space-y-1.5">
                  <div className="font-bold text-emerald-900 flex items-center gap-1.5">
                    <Sparkles className="w-4 h-4 text-emerald-600" />
                    <span>{t('result.counseling')}</span>
                  </div>
                  <p className="text-emerald-800 font-medium">
                    {activeScorecard.counselingStream}
                  </p>
                  <p className="text-[11px] text-slate-600">
                    {t('result.counselingHint')}
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="py-12 text-center text-slate-500 text-sm">
              {t('result.empty')}
            </div>
          )}
        </div>

        {/* Modal Actions Footer */}
        <div className="bg-slate-50 border-t border-slate-200 px-6 py-3.5 flex flex-wrap items-center justify-between gap-3">
          <div className="text-[11px] text-slate-500 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-[#16A34A]" />
            <span>{t('result.footer')}</span>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 border border-slate-300 hover:bg-slate-100 rounded-lg text-xs font-semibold text-slate-700 transition-colors"
            >
              {t('common.closeButton')}
            </button>
            <button
              onClick={handlePrint}
              disabled={!activeScorecard}
              className="px-4 py-2 bg-[#0B254E] hover:bg-[#071933] text-white rounded-lg text-xs font-bold transition-colors flex items-center gap-2 shadow-xs disabled:opacity-50"
            >
              <Printer className="w-3.5 h-3.5" />
              <span>{isPrinting ? t('result.preparingPrint') : t('result.print')}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
