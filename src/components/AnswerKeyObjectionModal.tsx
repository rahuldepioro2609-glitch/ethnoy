/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Clock,
  FileText,
  Loader2,
  Search,
  Send,
  ShieldCheck,
  Upload,
  X,
} from 'lucide-react';
import {
  AnswerKeyQuestion,
  AnswerOption,
  CandidateObjection,
  OBJECTION_CATEGORIES,
  ObjectionCategory,
  ProposedKey,
  filterQuestions,
  objectionStatusLabel,
  proposedKeyLabel,
  validateObjection,
} from '../utils/answerKeyLogic';
import { OBJECTION_DOCUMENT_MAX_BYTES, formatBytes, uploadFile } from '../utils/fileUpload';
import { apiRequest } from '../api';
import { useTranslation } from '../i18n';

interface AnswerKeyObjectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultExamName?: string;
}

interface ObjectionWindow {
  isOpen: boolean;
  closesAt: string | null;
}

interface PublishedKeyResponse {
  questions: Array<{
    question_number: number;
    subject: AnswerKeyQuestion['subject'];
    question_text: string;
    options: AnswerKeyQuestion['options'];
    official_key: AnswerOption;
    original_key: AnswerOption | null;
    explanation: string;
    status: AnswerKeyQuestion['status'];
  }>;
  objectionWindow: ObjectionWindow;
}

const OPTIONS: AnswerOption[] = ['A', 'B', 'C', 'D'];

const statusStyles: Record<AnswerKeyQuestion['status'], string> = {
  'Key Published': 'bg-emerald-100 text-emerald-800',
  'Under Challenge': 'bg-amber-100 text-amber-800',
  'Key Revised': 'bg-sky-100 text-sky-800',
  'Question Dropped': 'bg-slate-200 text-slate-700',
};

const objectionStyles: Record<CandidateObjection['status'], string> = {
  pending: 'bg-amber-100 text-amber-800',
  accepted: 'bg-emerald-100 text-emerald-800',
  rejected: 'bg-slate-100 text-slate-700',
};

export const AnswerKeyObjectionModal: React.FC<AnswerKeyObjectionModalProps> = ({
  isOpen,
  onClose,
  defaultExamName = '',
}) => {
  const { t, formatDateTime } = useTranslation();
  const [activeTab, setActiveTab] = useState<'keys' | 'my-objections'>('keys');
  const [questions, setQuestions] = useState<AnswerKeyQuestion[]>([]);
  const [objectionWindow, setObjectionWindow] = useState<ObjectionWindow>({ isOpen: false, closesAt: null });
  const [objections, setObjections] = useState<CandidateObjection[]>([]);
  const [keyLoadError, setKeyLoadError] = useState<string | null>(null);
  const [availableExamCodes, setAvailableExamCodes] = useState<string[]>([]);
  const [selectedExamCode, setSelectedExamCode] = useState('');
  const [examOptionsLoaded, setExamOptionsLoaded] = useState(false);
  const [examOptionsError, setExamOptionsError] = useState<string | null>(null);
  const [keysLoaded, setKeysLoaded] = useState(false);
  const [selectedSubject, setSelectedSubject] = useState('All');
  const [searchQuery, setSearchQuery] = useState('');

  const [activeChallengeQuestion, setActiveChallengeQuestion] = useState<AnswerKeyQuestion | null>(null);
  const [proposedOption, setProposedOption] = useState<ProposedKey>('A');
  const [objectionCategory, setObjectionCategory] = useState<ObjectionCategory>('Incorrect Key');
  const [justification, setJustification] = useState('');
  const [referenceSource, setReferenceSource] = useState('');
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successToast, setSuccessToast] = useState<string | null>(null);

  const preferredExamCode = defaultExamName.match(/\(([^()]*)\)\s*$/)?.[1] ?? '';

  const loadMyObjections = useCallback(() => {
    apiRequest<{ objections: CandidateObjection[] }>('/api/answer-keys/objections/mine')
      .then(({ objections: mine }) => setObjections(mine))
      .catch(() => setObjections([]));
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    setExamOptionsLoaded(false);
    setExamOptionsError(null);
    setSelectedExamCode('');
    loadMyObjections();
    let cancelled = false;
    apiRequest<{ examCodes: string[] }>('/api/answer-keys/exams')
      .then(({ examCodes }) => {
        if (cancelled) return;
        setAvailableExamCodes(examCodes);
        setSelectedExamCode(examCodes.includes(preferredExamCode) ? preferredExamCode : examCodes[0] ?? '');
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setExamOptionsError(loadError instanceof Error ? loadError.message : t('answerKey.loadExamsError'));
      })
      .finally(() => {
        if (!cancelled) setExamOptionsLoaded(true);
      });
    return () => { cancelled = true; };
  }, [isOpen, loadMyObjections, preferredExamCode, t]);

  const loadKey = useCallback((examCode: string, signal: { cancelled: boolean }) => {
    setKeyLoadError(null);
    setKeysLoaded(false);
    apiRequest<PublishedKeyResponse>(`/api/answer-keys?examCode=${encodeURIComponent(examCode)}`)
      .then(({ questions: published, objectionWindow: window }) => {
        if (signal.cancelled) return;
        setObjectionWindow(window);
        setQuestions(published.map((question) => ({
          questionNumber: question.question_number,
          subject: question.subject,
          questionText: question.question_text,
          options: question.options,
          officialKey: question.official_key,
          originalKey: question.original_key,
          status: question.status,
          explanation: question.explanation,
        })));
      })
      .catch((loadError: unknown) => {
        if (!signal.cancelled) setKeyLoadError(loadError instanceof Error ? loadError.message : t('answerKey.loadKeyError'));
      })
      .finally(() => {
        if (!signal.cancelled) setKeysLoaded(true);
      });
  }, [t]);

  useEffect(() => {
    if (!isOpen || !examOptionsLoaded || examOptionsError || !selectedExamCode) return;
    setQuestions([]);
    const signal = { cancelled: false };
    loadKey(selectedExamCode, signal);
    return () => { signal.cancelled = true; };
  }, [examOptionsError, examOptionsLoaded, isOpen, loadKey, selectedExamCode]);

  const filedQuestions = useMemo(
    () => new Set(objections.filter((item) => item.examCode === selectedExamCode).map((item) => item.questionNumber)),
    [objections, selectedExamCode],
  );

  if (!isOpen) return null;

  const filteredQuestions = filterQuestions(questions, selectedSubject, searchQuery);
  const examObjections = objections.filter((item) => item.examCode === selectedExamCode);

  const handleOpenChallenge = (question: AnswerKeyQuestion) => {
    setActiveChallengeQuestion(question);
    setProposedOption(OPTIONS.find((option) => option !== question.officialKey) ?? 'NONE');
    setObjectionCategory('Incorrect Key');
    setJustification('');
    setReferenceSource('');
    setEvidenceFile(null);
    setFormError(null);
  };

  const handleEvidenceChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = '';
    if (!file) return;
    if (!['application/pdf', 'image/jpeg', 'image/png'].includes(file.type)) {
      setFormError(t('answerKey.evidenceType'));
      return;
    }
    if (file.size > OBJECTION_DOCUMENT_MAX_BYTES) {
      setFormError(t('answerKey.evidenceSize', { size: formatBytes(OBJECTION_DOCUMENT_MAX_BYTES) }));
      return;
    }
    setFormError(null);
    setEvidenceFile(file);
  };

  const handleSubmitObjection = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!activeChallengeQuestion) return;
    const validation = validateObjection({
      questionNumber: activeChallengeQuestion.questionNumber,
      proposedKey: proposedOption,
      justification,
      referenceSource,
    });
    if (!validation.isValid) {
      setFormError(validation.error ?? t('answerKey.checkFields'));
      return;
    }
    setIsSubmitting(true);
    setFormError(null);
    try {
      const document = evidenceFile ? await uploadFile('objection_document', evidenceFile, evidenceFile.name) : null;
      const { objection } = await apiRequest<{ objection: CandidateObjection }>('/api/answer-keys/objections', {
        method: 'POST',
        body: JSON.stringify({
          examCode: selectedExamCode,
          questionNumber: activeChallengeQuestion.questionNumber,
          proposedKey: proposedOption,
          category: objectionCategory,
          justification: justification.trim(),
          referenceSource: referenceSource.trim(),
          ...(document ? { documentFileId: document.id } : {}),
        }),
      });
      setSuccessToast(t('answerKey.filed', { reference: objection.referenceNumber, question: objection.questionNumber }));
      setActiveChallengeQuestion(null);
      setActiveTab('my-objections');
      loadMyObjections();
      loadKey(selectedExamCode, { cancelled: false });
      window.setTimeout(() => setSuccessToast(null), 8000);
    } catch (submitError) {
      setFormError(submitError instanceof Error ? submitError.message : t('answerKey.submitError'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const windowLabel = objectionWindow.isOpen
    ? objectionWindow.closesAt
      ? t('answerKey.windowOpenUntil', { date: formatDateTime(objectionWindow.closesAt) })
      : t('answerKey.windowOpen')
    : t('answerKey.windowClosed');

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="answer-key-modal-title"
      className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/80 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5"
    >
      <div className="bg-white rounded-2xl shadow-2xl max-w-5xl w-full border border-slate-200 overflow-hidden flex flex-col max-h-[92vh] animate-in fade-in zoom-in-95 duration-150">
        <div className="bg-[#0B254E] text-white px-6 py-4 flex items-center justify-between border-b border-sky-900">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 shrink-0 rounded-xl bg-purple-500/20 border border-purple-400/30 flex items-center justify-center text-purple-300">
              <FileText className="w-6 h-6 stroke-[2.2]" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 id="answer-key-modal-title" className="text-lg font-bold tracking-tight">
                  {t('answerKey.title')}
                </h2>
                {selectedExamCode && (
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                    objectionWindow.isOpen
                      ? 'bg-emerald-500/20 text-emerald-200 border-emerald-400/30'
                      : 'bg-white/10 text-slate-300 border-white/20'
                  }`}>
                    {windowLabel}
                  </span>
                )}
              </div>
              <p className="text-xs text-sky-200 truncate">{selectedExamCode || t('answerKey.noExamSelected')}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-white/10 transition-colors"
            aria-label={t('common.close')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {successToast && (
          <div role="status" className="bg-emerald-50 border-b border-emerald-200 px-6 py-2.5 text-xs text-emerald-800 font-semibold flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>{successToast}</span>
          </div>
        )}

        <div className="bg-slate-50 border-b border-slate-200 p-4 sm:px-6 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex flex-wrap items-center gap-3">
            {availableExamCodes.length > 1 && (
              <label className="flex items-center gap-1.5 font-bold text-slate-700">
                {t('answerKey.exam')}
                <select
                  value={selectedExamCode}
                  onChange={(event) => setSelectedExamCode(event.target.value)}
                  className="px-2.5 py-1 bg-white border border-slate-300 rounded-lg font-semibold text-slate-800"
                >
                  {availableExamCodes.map((code) => <option key={code} value={code}>{code}</option>)}
                </select>
              </label>
            )}
            <label className="flex items-center gap-1.5 font-bold text-slate-700">
              {t('answerKey.subject')}
              <select
                value={selectedSubject}
                onChange={(event) => setSelectedSubject(event.target.value)}
                className="px-2.5 py-1 bg-white border border-slate-300 rounded-lg font-semibold text-slate-800"
              >
                <option value="All">{t('answerKey.allSubjects', { count: questions.length })}</option>
                {(['Mathematics', 'Physics', 'Chemistry', 'Logical Reasoning'] as const).map((subject) => (
                  <option key={subject} value={subject}>{t(`subject.${subject}`)}</option>
                ))}
              </select>
            </label>
            <label className="relative flex items-center">
              <span className="sr-only">{t('answerKey.search')}</span>
              <Search className="absolute left-2 h-3.5 w-3.5 text-slate-400" />
              <input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={t('answerKey.search')}
                className="w-40 pl-7 pr-2 py-1 bg-white border border-slate-300 rounded-lg text-slate-800"
              />
            </label>
          </div>

          <div className="flex items-center gap-1 bg-slate-200/70 p-1 rounded-lg" role="tablist">
            <button
              role="tab"
              aria-selected={activeTab === 'keys'}
              onClick={() => setActiveTab('keys')}
              className={`px-3 py-1 rounded-md font-bold text-xs transition-colors ${
                activeTab === 'keys' ? 'bg-white text-[#0B254E] shadow-2xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {t('answerKey.tabKey', { count: questions.length })}
            </button>
            <button
              role="tab"
              aria-selected={activeTab === 'my-objections'}
              onClick={() => setActiveTab('my-objections')}
              className={`px-3 py-1 rounded-md font-bold text-xs transition-colors flex items-center gap-1.5 ${
                activeTab === 'my-objections' ? 'bg-white text-purple-700 shadow-2xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <span>{t('answerKey.tabMine')}</span>
              <span className="px-1.5 rounded-full text-[10px] bg-purple-100 text-purple-800">{examObjections.length}</span>
            </button>
          </div>
        </div>

        <div className="overflow-y-auto p-5 sm:p-6 flex-1 space-y-4">
          {activeTab === 'keys' && (
            <div className="space-y-4">
              <div className="bg-sky-50 border border-sky-200 rounded-xl p-3.5 text-xs text-sky-900 flex items-start gap-2.5">
                <BookOpen className="w-4 h-4 text-sky-600 shrink-0 mt-0.5" />
                <div>
                  <span className="font-bold block">
                    {examOptionsError || keyLoadError
                      ? t('answerKey.loadFailed')
                      : questions.length
                        ? t('answerKey.officialKeyFor', { exam: selectedExamCode })
                        : t('answerKey.noKeyFor', { exam: selectedExamCode || t('answerKey.thisExam') })}
                  </span>
                  <span className="text-sky-800 text-[11px]">
                    {examOptionsError ?? keyLoadError ?? (objectionWindow.isOpen
                      ? t('answerKey.howToObject')
                      : t('answerKey.windowClosedHelp'))}
                  </span>
                </div>
              </div>

              <div className="space-y-3">
                {!examOptionsLoaded && <p className="rounded-lg border border-slate-200 bg-white p-5 text-sm text-slate-600">{t('common.loading')}</p>}
                {examOptionsLoaded && !availableExamCodes.length && !examOptionsError && (
                  <p className="rounded-lg border border-slate-200 bg-white p-5 text-sm text-slate-600">{t('answerKey.noPublishedKeys')}</p>
                )}
                {keysLoaded && Boolean(selectedExamCode) && !questions.length && !keyLoadError && (
                  <p className="rounded-lg border border-slate-200 bg-white p-5 text-sm text-slate-600">{t('answerKey.noQuestions')}</p>
                )}
                {filteredQuestions.map((question) => {
                  const alreadyFiled = filedQuestions.has(question.questionNumber);
                  const canObject = objectionWindow.isOpen && !alreadyFiled && question.status !== 'Question Dropped';
                  return (
                    <div key={question.questionNumber} className="border border-slate-200 rounded-xl p-4 bg-white hover:border-slate-300 transition-all shadow-2xs space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="min-w-7 h-7 px-1 rounded-lg bg-[#0B254E] text-white flex items-center justify-center font-bold text-xs">
                            Q{question.questionNumber}
                          </span>
                          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-700">{t(`subject.${question.subject}`)}</span>
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${statusStyles[question.status]}`}>
                            {t(`answerKey.status.${question.status}`)}
                          </span>
                        </div>
                        {alreadyFiled ? (
                          <span className="px-3 py-1 rounded-lg text-xs font-bold bg-purple-50 text-purple-700 border border-purple-200">
                            {t('answerKey.objectionFiled')}
                          </span>
                        ) : (
                          <button
                            type="button"
                            disabled={!canObject}
                            onClick={() => handleOpenChallenge(question)}
                            title={canObject ? undefined : t('answerKey.windowClosed')}
                            className="px-3 py-1 rounded-lg text-xs font-bold flex items-center gap-1 transition-colors bg-purple-600 text-white hover:bg-purple-700 disabled:bg-slate-100 disabled:text-slate-500 disabled:cursor-not-allowed"
                          >
                            {t('answerKey.raiseObjection')}
                          </button>
                        )}
                      </div>

                      <div className="text-xs sm:text-sm font-semibold text-slate-900 leading-relaxed pl-1">{question.questionText}</div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                        {OPTIONS.map((option) => {
                          const isOfficial = question.officialKey === option && question.status !== 'Question Dropped';
                          const wasOriginal = question.originalKey === option;
                          return (
                            <div
                              key={option}
                              className={`p-2.5 rounded-lg border flex items-center justify-between gap-2 ${
                                isOfficial ? 'bg-emerald-50 border-emerald-300 text-emerald-950 font-bold' : 'bg-slate-50 border-slate-200 text-slate-700'
                              }`}
                            >
                              <div className="flex items-center gap-2">
                                <span className="w-5 h-5 shrink-0 rounded-full bg-white border border-slate-300 flex items-center justify-center font-bold text-[10px]">{option}</span>
                                <span>{question.options[option]}</span>
                              </div>
                              {isOfficial && <span className="shrink-0 px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-600 text-white">{t('answerKey.officialKey')}</span>}
                              {wasOriginal && <span className="shrink-0 px-1.5 py-0.5 rounded text-[9px] font-bold bg-slate-200 text-slate-600 line-through">{t('answerKey.previousKey')}</span>}
                            </div>
                          );
                        })}
                      </div>

                      {question.explanation && (
                        <div className="bg-slate-50 rounded-lg p-2.5 text-[11px] text-slate-600 border border-slate-100 flex items-start gap-2">
                          <span className="font-bold text-slate-700 shrink-0">{t('answerKey.explanation')}</span>
                          <span>{question.explanation}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {activeTab === 'my-objections' && (
            <div className="space-y-4">
              <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">{t('answerKey.myObjectionsTitle')}</h3>
              {examObjections.length === 0 ? (
                <div className="text-center py-12 text-slate-500 text-xs">{t('answerKey.noObjections')}</div>
              ) : (
                <div className="space-y-3">
                  {examObjections.map((objection) => (
                    <div key={objection.id} className="border border-slate-200 rounded-xl p-5 bg-white shadow-2xs space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-bold text-xs text-[#0B254E] bg-sky-50 px-2 py-0.5 rounded border border-sky-200">{objection.referenceNumber}</span>
                          <span className="text-xs font-bold text-slate-800">{t('answerKey.questionN', { n: objection.questionNumber })}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold flex items-center gap-1 ${objectionStyles[objection.status]}`}>
                            {objection.status === 'pending' ? <Clock className="w-3 h-3" /> : <ShieldCheck className="w-3 h-3" />}
                            {t(`answerKey.outcome.${objectionStatusLabel(objection)}`)}
                          </span>
                          <span className="text-xs font-semibold text-slate-500">{formatDateTime(objection.createdAt)}</span>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                        <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-100">
                          <span className="text-slate-400 font-bold block text-[10px] uppercase">{t('answerKey.keyVsClaim')}</span>
                          <span className="font-semibold text-slate-800">
                            {t('answerKey.official')}: <strong>Option {objection.officialKey}</strong> → {t('answerKey.claim')}: <strong className="text-purple-700">{proposedKeyLabel(objection.proposedKey)}</strong>
                          </span>
                        </div>
                        <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-100">
                          <span className="text-slate-400 font-bold block text-[10px] uppercase">{t('answerKey.category')}</span>
                          <span className="font-semibold text-slate-800">{objection.category}</span>
                        </div>
                      </div>

                      <div className="text-xs space-y-1">
                        <span className="text-slate-400 font-bold text-[10px] uppercase block">{t('answerKey.justification')}</span>
                        <p className="text-slate-700 font-medium bg-slate-50 p-2.5 rounded-lg border border-slate-100 whitespace-pre-line">{objection.justification}</p>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                        <div><strong>{t('answerKey.reference')}:</strong> {objection.referenceSource}</div>
                        {objection.documentFileId && (
                          <a href={`/api/files/${encodeURIComponent(objection.documentFileId)}`} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-purple-700 font-semibold underline">
                            <FileText className="w-3.5 h-3.5" />
                            {objection.documentName ?? t('answerKey.supportingDocument')}
                          </a>
                        )}
                      </div>

                      {objection.reviewerRemarks && (
                        <div className="bg-purple-50/70 border border-purple-100 rounded-lg p-2.5 text-xs text-purple-900">
                          <strong>{t('answerKey.panelRemarks')}:</strong> {objection.reviewerRemarks}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {activeChallengeQuestion && (
          <div className="fixed inset-0 z-60 bg-black/50 backdrop-blur-2xs flex items-center justify-center p-4">
            <div role="dialog" aria-modal="true" aria-labelledby="objection-form-title" className="bg-white rounded-2xl max-w-xl w-full border border-slate-200 shadow-2xl overflow-hidden flex flex-col max-h-[90vh] animate-in zoom-in-95 duration-150">
              <div className="bg-[#0B254E] text-white px-5 py-3.5 flex items-center justify-between">
                <div>
                  <h3 id="objection-form-title" className="font-bold text-sm">{t('answerKey.formTitle', { n: activeChallengeQuestion.questionNumber })}</h3>
                  <p className="text-xs text-sky-200">{t(`subject.${activeChallengeQuestion.subject}`)} · {selectedExamCode}</p>
                </div>
                <button onClick={() => setActiveChallengeQuestion(null)} aria-label={t('common.close')} className="p-1 text-slate-300 hover:text-white">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form onSubmit={(event) => void handleSubmitObjection(event)} className="p-5 overflow-y-auto space-y-4 text-xs flex-1">
                {formError && (
                  <div role="alert" className="bg-rose-50 border border-rose-200 text-rose-800 p-2.5 rounded-lg font-semibold flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                    <span>{formError}</span>
                  </div>
                )}

                <div className="bg-slate-50 p-3 rounded-xl border border-slate-200">
                  <span className="font-bold text-slate-500 uppercase text-[10px] block">{t('answerKey.question')}</span>
                  <p className="font-semibold text-slate-900 mt-1">{activeChallengeQuestion.questionText}</p>
                  <div className="mt-2 text-[11px] text-slate-600">
                    {t('answerKey.officialKey')}: <strong className="text-emerald-700 font-bold">Option {activeChallengeQuestion.officialKey}</strong>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label className="block">
                    <span className="block font-bold text-slate-700 uppercase tracking-wider mb-1">{t('answerKey.proposedAnswer')} *</span>
                    <select
                      value={proposedOption}
                      onChange={(event) => setProposedOption(event.target.value as ProposedKey)}
                      className="w-full text-xs font-semibold px-3 py-2 bg-white border border-slate-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-purple-600"
                    >
                      {OPTIONS.filter((option) => option !== activeChallengeQuestion.officialKey).map((option) => (
                        <option key={option} value={option}>Option {option} ({activeChallengeQuestion.options[option]})</option>
                      ))}
                      <option value="NONE">{t('answerKey.noneCorrect')}</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="block font-bold text-slate-700 uppercase tracking-wider mb-1">{t('answerKey.category')} *</span>
                    <select
                      value={objectionCategory}
                      onChange={(event) => setObjectionCategory(event.target.value as ObjectionCategory)}
                      className="w-full text-xs font-semibold px-3 py-2 bg-white border border-slate-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-purple-600"
                    >
                      {OBJECTION_CATEGORIES.map((category) => <option key={category} value={category}>{category}</option>)}
                    </select>
                  </label>
                </div>

                <label className="block">
                  <span className="block font-bold text-slate-700 uppercase tracking-wider mb-1">{t('answerKey.justificationLabel')} *</span>
                  <textarea
                    rows={4}
                    required
                    minLength={15}
                    maxLength={3000}
                    value={justification}
                    onChange={(event) => setJustification(event.target.value)}
                    placeholder={t('answerKey.justificationPlaceholder')}
                    className="w-full text-xs px-3 py-2 bg-white border border-slate-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-purple-600 text-slate-900"
                  />
                  <span className="block text-right text-[10px] text-slate-400">{justification.length} / 3000</span>
                </label>

                <label className="block">
                  <span className="block font-bold text-slate-700 uppercase tracking-wider mb-1">{t('answerKey.referenceLabel')} *</span>
                  <input
                    type="text"
                    required
                    minLength={5}
                    maxLength={500}
                    value={referenceSource}
                    onChange={(event) => setReferenceSource(event.target.value)}
                    placeholder={t('answerKey.referencePlaceholder')}
                    className="w-full text-xs px-3 py-2 bg-white border border-slate-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-purple-600 text-slate-900 font-medium"
                  />
                </label>

                <div>
                  <span className="block font-bold text-slate-700 uppercase tracking-wider mb-1">{t('answerKey.evidenceLabel')}</span>
                  <label className="border-2 border-dashed border-slate-300 hover:border-purple-500 rounded-xl p-3 flex flex-col items-center justify-center gap-1 cursor-pointer bg-slate-50 hover:bg-purple-50/30 transition-colors">
                    <Upload className="w-5 h-5 text-slate-400" />
                    <span className="text-[11px] font-semibold text-slate-700">
                      {evidenceFile
                        ? <span className="text-emerald-700 font-bold">{t('answerKey.attached', { name: evidenceFile.name, size: formatBytes(evidenceFile.size) })}</span>
                        : t('answerKey.evidenceHint')}
                    </span>
                    <input type="file" accept="application/pdf,image/jpeg,image/png" onChange={handleEvidenceChange} className="sr-only" />
                  </label>
                  {evidenceFile && (
                    <button type="button" onClick={() => setEvidenceFile(null)} className="mt-1 text-[11px] font-semibold text-slate-500 underline">{t('answerKey.removeAttachment')}</button>
                  )}
                </div>

                <p className="p-3 bg-purple-50 rounded-xl border border-purple-200 text-[11px] text-purple-900">{t('answerKey.noFeeNotice')}</p>

                <div className="flex items-center justify-end gap-2 pt-2">
                  <button type="button" onClick={() => setActiveChallengeQuestion(null)} className="px-4 py-2 border border-slate-300 rounded-lg text-slate-700 font-semibold">
                    {t('common.cancel')}
                  </button>
                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-60 text-white font-bold rounded-lg transition-colors flex items-center gap-1.5 shadow-xs"
                  >
                    {isSubmitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                    <span>{isSubmitting ? t('common.submitting') : t('answerKey.submit')}</span>
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        <div className="bg-slate-50 border-t border-slate-200 px-6 py-3.5 flex items-center justify-between gap-3 text-xs text-slate-500">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 shrink-0 text-purple-600" />
            <span>{t('answerKey.footer')}</span>
          </div>
          <button onClick={onClose} className="px-4 py-2 bg-[#0B254E] hover:bg-[#071933] text-white rounded-lg text-xs font-bold transition-colors shadow-xs">
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );
};
