/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  X,
  Award,
  Search,
  Filter,
  CheckCircle2,
  AlertTriangle,
  Upload,
  FileText,
  Clock,
  ShieldCheck,
  ChevronRight,
  BookOpen,
  DollarSign,
  Send,
  ExternalLink,
} from 'lucide-react';
import {
  SAMPLE_ANSWER_KEYS,
  INITIAL_OBJECTIONS,
  calculateObjectionFee,
  validateObjection,
  filterQuestions,
  AnswerKeyQuestion,
  CandidateObjection,
} from '../utils/answerKeyLogic';

interface AnswerKeyObjectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultExamName?: string;
}

export const AnswerKeyObjectionModal: React.FC<AnswerKeyObjectionModalProps> = ({
  isOpen,
  onClose,
  defaultExamName = 'ELTNOY National Test 2025 (ENT-2025)',
}) => {
  const [activeTab, setActiveTab] = useState<'keys' | 'my-objections'>('keys');
  const [questions, setQuestions] = useState<AnswerKeyQuestion[]>(SAMPLE_ANSWER_KEYS);
  const [objections, setObjections] = useState<CandidateObjection[]>(INITIAL_OBJECTIONS);
  const [selectedSubject, setSelectedSubject] = useState<string>('All');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedBookletSet, setSelectedBookletSet] = useState<string>('Set A');

  // Active Objection Filing Drawer / Form
  const [activeChallengeQuestion, setActiveChallengeQuestion] = useState<AnswerKeyQuestion | null>(null);
  const [proposedOption, setProposedOption] = useState<'A' | 'B' | 'C' | 'D' | 'All Options Invalid'>('C');
  const [objectionCategory, setObjectionCategory] = useState<
    'Incorrect Key' | 'Ambiguous Question' | 'Multiple Answers' | 'Out of Syllabus' | 'Typographical Discrepancy'
  >('Incorrect Key');
  const [justification, setJustification] = useState('');
  const [referenceSource, setReferenceSource] = useState('');
  const [uploadedDocName, setUploadedDocName] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [successToast, setSuccessToast] = useState<string | null>(null);

  if (!isOpen) return null;

  const filteredQuestions = filterQuestions(questions, selectedSubject, searchQuery);

  const handleOpenChallenge = (q: AnswerKeyQuestion) => {
    setActiveChallengeQuestion(q);
    setProposedOption(q.officialKey === 'A' ? 'B' : 'A');
    setJustification('');
    setReferenceSource('');
    setUploadedDocName(null);
    setFormError(null);
  };

  const handleMockFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setUploadedDocName(file.name);
    }
  };

  const handleSubmitObjection = (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeChallengeQuestion) return;

    const validation = validateObjection({
      questionNumber: activeChallengeQuestion.questionNumber,
      proposedKey: proposedOption,
      justification,
      referenceSource,
    });

    if (!validation.isValid) {
      setFormError(validation.error || 'Please check all required fields.');
      return;
    }

    const newObj: CandidateObjection = {
      id: `OBJ-2025-${(objections.length + 15).toString().padStart(3, '0')}`,
      questionNumber: activeChallengeQuestion.questionNumber,
      subject: activeChallengeQuestion.subject,
      officialKey: activeChallengeQuestion.officialKey,
      proposedKey: proposedOption,
      objectionCategory,
      justification,
      referenceSource,
      attachedDocumentName: uploadedDocName || 'Reference_Textbook_Proof.pdf',
      attachedDocumentSize: '1.2 MB',
      feePaid: 500,
      submissionDate: '30 Apr 2025',
      status: 'Under Review by Expert Panel',
      expertRemarks: 'Assigned to Senior Subject Matter Expert committee.',
    };

    setObjections([newObj, ...objections]);

    // Update status in question item
    setQuestions((prev) =>
      prev.map((item) =>
        item.questionNumber === activeChallengeQuestion.questionNumber
          ? { ...item, status: 'Under Challenge' }
          : item
      )
    );

    setSuccessToast(
      `Objection challenge #${newObj.id} for Question ${activeChallengeQuestion.questionNumber} successfully registered! Fee of ₹500 recorded.`
    );
    setActiveChallengeQuestion(null);
    setActiveTab('my-objections');
    setTimeout(() => setSuccessToast(null), 6000);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="answer-key-modal-title"
      className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/80 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5"
    >
      <div className="bg-white rounded-2xl shadow-2xl max-w-5xl w-full border border-slate-200 overflow-hidden flex flex-col max-h-[92vh] animate-in fade-in zoom-in-95 duration-150">
        {/* Header Bar */}
        <div className="bg-[#0B254E] text-white px-6 py-4 flex items-center justify-between border-b border-sky-900">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-purple-500/20 border border-purple-400/30 flex items-center justify-center text-purple-300">
              <FileText className="w-6 h-6 stroke-[2.2]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 id="answer-key-modal-title" className="text-lg font-bold tracking-tight">
                  Official Answer Key &amp; Online Objection Tracker
                </h2>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-500/20 text-purple-200 border border-purple-400/30">
                  Window: Active
                </span>
              </div>
              <p className="text-xs text-sky-200">{defaultExamName} · Provisional Answer Key Challenge Portal</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-white/10 transition-colors"
            aria-label="Close Answer Key Portal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Global Toast */}
        {successToast && (
          <div className="bg-emerald-50 border-b border-emerald-200 px-6 py-2.5 text-xs text-emerald-800 font-semibold flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>{successToast}</span>
          </div>
        )}

        {/* Top Controls Strip: Exam & Set selector, Search, Tabs */}
        <div className="bg-slate-50 border-b border-slate-200 p-4 sm:px-6 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5">
              <span className="font-bold text-slate-700">Question Booklet:</span>
              <select
                value={selectedBookletSet}
                onChange={(e) => setSelectedBookletSet(e.target.value)}
                className="px-2.5 py-1 bg-white border border-slate-300 rounded-lg font-semibold text-slate-800"
              >
                <option value="Set A">Set A (Series 101)</option>
                <option value="Set B">Set B (Series 102)</option>
                <option value="Set C">Set C (Series 103)</option>
                <option value="Set D">Set D (Series 104)</option>
              </select>
            </div>

            <div className="flex items-center gap-1.5">
              <span className="font-bold text-slate-700">Subject:</span>
              <select
                value={selectedSubject}
                onChange={(e) => setSelectedSubject(e.target.value)}
                className="px-2.5 py-1 bg-white border border-slate-300 rounded-lg font-semibold text-slate-800"
              >
                <option value="All">All Subjects ({questions.length} Questions)</option>
                <option value="Mathematics">Mathematics</option>
                <option value="Physics">Physics</option>
                <option value="Chemistry">Chemistry</option>
                <option value="Logical Reasoning">Logical Reasoning</option>
              </select>
            </div>
          </div>

          {/* Tab Switcher */}
          <div className="flex items-center gap-1 bg-slate-200/70 p-1 rounded-lg">
            <button
              onClick={() => setActiveTab('keys')}
              className={`px-3 py-1 rounded-md font-bold text-xs transition-colors ${
                activeTab === 'keys' ? 'bg-white text-[#0B254E] shadow-2xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Question Key Matrix ({questions.length})
            </button>
            <button
              onClick={() => setActiveTab('my-objections')}
              className={`px-3 py-1 rounded-md font-bold text-xs transition-colors flex items-center gap-1.5 ${
                activeTab === 'my-objections'
                  ? 'bg-white text-purple-700 shadow-2xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <span>My Filed Objections</span>
              <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-purple-100 text-purple-800">
                {objections.length}
              </span>
            </button>
          </div>
        </div>

        {/* Main Content Area */}
        <div className="overflow-y-auto p-5 sm:p-6 flex-1 space-y-4">
          {/* TAB 1: Question Key Matrix */}
          {activeTab === 'keys' && (
            <div className="space-y-4">
              {/* Challenge guidelines banner */}
              <div className="bg-sky-50 border border-sky-200 rounded-xl p-3.5 text-xs text-sky-900 flex items-start justify-between gap-3">
                <div className="flex items-start gap-2.5">
                  <BookOpen className="w-4 h-4 text-sky-600 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-bold block">How to File an Online Challenge:</span>
                    <span className="text-sky-800 text-[11px]">
                      Compare the Official Key with your recorded response. If you believe the official key is incorrect,
                      click <strong>"Challenge Key"</strong> on that question, cite standard textbook references, and upload proof.
                      Fee is ₹500 per question (100% refunded if challenge is upheld by the expert committee).
                    </span>
                  </div>
                </div>
              </div>

              {/* Question Items List */}
              <div className="space-y-3">
                {filteredQuestions.map((q) => (
                  <div
                    key={q.questionNumber}
                    className="border border-slate-200 rounded-xl p-4 bg-white hover:border-slate-300 transition-all shadow-2xs space-y-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="w-7 h-7 rounded-lg bg-[#0B254E] text-white flex items-center justify-center font-bold text-xs">
                          Q{q.questionNumber}
                        </span>
                        <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-700">
                          {q.subject}
                        </span>
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                            q.status === 'Under Challenge'
                              ? 'bg-amber-100 text-amber-800'
                              : 'bg-emerald-100 text-emerald-800'
                          }`}
                        >
                          {q.status}
                        </span>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleOpenChallenge(q)}
                          className="px-3 py-1 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-xs font-bold transition-colors flex items-center gap-1 shadow-2xs"
                        >
                          <span>Challenge Key</span>
                          <ChevronRight className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* Question Text */}
                    <div className="text-xs sm:text-sm font-semibold text-slate-900 leading-relaxed pl-1">
                      {q.questionText}
                    </div>

                    {/* 4 Options Grid */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                      {(['A', 'B', 'C', 'D'] as const).map((opt) => {
                        const isOfficial = q.officialKey === opt;
                        const isCandidate = q.candidateResponse === opt;

                        return (
                          <div
                            key={opt}
                            className={`p-2.5 rounded-lg border flex items-center justify-between ${
                              isOfficial
                                ? 'bg-emerald-50 border-emerald-300 text-emerald-950 font-bold'
                                : isCandidate
                                ? 'bg-sky-50 border-sky-300 text-sky-950 font-medium'
                                : 'bg-slate-50 border-slate-200 text-slate-700'
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <span className="w-5 h-5 rounded-full bg-white border border-slate-300 flex items-center justify-center font-bold text-[10px]">
                                {opt}
                              </span>
                              <span>{q.options[opt]}</span>
                            </div>

                            <div className="flex items-center gap-1.5 shrink-0">
                              {isOfficial && (
                                <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-600 text-white">
                                  Official Key
                                </span>
                              )}
                              {isCandidate && !isOfficial && (
                                <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-sky-600 text-white">
                                  Your Response
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Official Solution Explanation */}
                    <div className="bg-slate-50 rounded-lg p-2.5 text-[11px] text-slate-600 border border-slate-100 flex items-start gap-2">
                      <span className="font-bold text-slate-700 shrink-0">Official Explanation:</span>
                      <span>{q.explanation}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* TAB 2: My Submitted Objections Tracker */}
          {activeTab === 'my-objections' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                  Submitted Challenge Claims &amp; Expert Committee Verification Status
                </h4>
                <span className="text-xs text-slate-500 font-medium">
                  Total Challenge Fee Recorded: ₹{calculateObjectionFee(objections.length)}
                </span>
              </div>

              {objections.length === 0 ? (
                <div className="text-center py-12 text-slate-500 text-xs">
                  No objections filed yet. You can challenge any question from the Question Key Matrix tab.
                </div>
              ) : (
                <div className="space-y-3">
                  {objections.map((obj) => (
                    <div
                      key={obj.id}
                      className="border border-slate-200 rounded-xl p-5 bg-white shadow-2xs space-y-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-bold text-xs text-[#0B254E] bg-sky-50 px-2 py-0.5 rounded border border-sky-200">
                            {obj.id}
                          </span>
                          <span className="text-xs font-bold text-slate-800">
                            Question #{obj.questionNumber} ({obj.subject})
                          </span>
                        </div>

                        <div className="flex items-center gap-2">
                          <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-100 text-amber-800 flex items-center gap-1">
                            <Clock className="w-3 h-3 text-amber-600" />
                            {obj.status}
                          </span>
                          <span className="text-xs font-semibold text-slate-500">
                            Filed: {obj.submissionDate}
                          </span>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                        <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-100">
                          <span className="text-slate-400 font-bold block text-[10px] uppercase">Official Key vs Claim</span>
                          <span className="font-semibold text-slate-800">
                            Official: <strong>Option {obj.officialKey}</strong> → Claim: <strong className="text-purple-700">Option {obj.proposedKey}</strong>
                          </span>
                        </div>

                        <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-100">
                          <span className="text-slate-400 font-bold block text-[10px] uppercase">Objection Category</span>
                          <span className="font-semibold text-slate-800">{obj.objectionCategory}</span>
                        </div>

                        <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-100">
                          <span className="text-slate-400 font-bold block text-[10px] uppercase">Processing Fee</span>
                          <span className="font-semibold text-emerald-700">₹{obj.feePaid} (Paid &amp; Receipt Logged)</span>
                        </div>
                      </div>

                      <div className="text-xs space-y-1">
                        <span className="text-slate-400 font-bold text-[10px] uppercase block">Candidate Justification:</span>
                        <p className="text-slate-700 font-medium bg-slate-50 p-2.5 rounded-lg border border-slate-100">
                          {obj.justification}
                        </p>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 pt-1">
                        <div>
                          <strong>Reference Source Cited:</strong> {obj.referenceSource}
                        </div>
                        {obj.attachedDocumentName && (
                          <div className="flex items-center gap-1.5 text-purple-700 font-semibold">
                            <FileText className="w-3.5 h-3.5" />
                            <span>{obj.attachedDocumentName} ({obj.attachedDocumentSize})</span>
                          </div>
                        )}
                      </div>

                      {obj.expertRemarks && (
                        <div className="bg-purple-50/70 border border-purple-100 rounded-lg p-2.5 text-xs text-purple-900">
                          <strong>Committee Audit Note:</strong> {obj.expertRemarks}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Challenge Filing Drawer / Modal Overlay */}
        {activeChallengeQuestion && (
          <div className="fixed inset-0 z-60 bg-black/50 backdrop-blur-2xs flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl max-w-xl w-full border border-slate-200 shadow-2xl overflow-hidden flex flex-col max-h-[90vh] animate-in zoom-in-95 duration-150">
              <div className="bg-[#0B254E] text-white px-5 py-3.5 flex items-center justify-between">
                <div>
                  <h3 className="font-bold text-sm">
                    File Key Challenge · Question {activeChallengeQuestion.questionNumber}
                  </h3>
                  <p className="text-xs text-sky-200">{activeChallengeQuestion.subject} · {selectedBookletSet}</p>
                </div>
                <button
                  onClick={() => setActiveChallengeQuestion(null)}
                  className="p-1 text-slate-300 hover:text-white"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form onSubmit={handleSubmitObjection} className="p-5 overflow-y-auto space-y-4 text-xs flex-1">
                {formError && (
                  <div className="bg-rose-50 border border-rose-200 text-rose-800 p-2.5 rounded-lg font-semibold flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                    <span>{formError}</span>
                  </div>
                )}

                <div className="bg-slate-50 p-3 rounded-xl border border-slate-200">
                  <span className="font-bold text-slate-500 uppercase text-[10px] block">Question:</span>
                  <p className="font-semibold text-slate-900 mt-1">{activeChallengeQuestion.questionText}</p>
                  <div className="mt-2 text-[11px] text-slate-600">
                    Official Answer Key: <strong className="text-emerald-700 font-bold">Option {activeChallengeQuestion.officialKey}</strong>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block font-bold text-slate-700 uppercase tracking-wider mb-1">
                      Proposed Correct Option *
                    </label>
                    <select
                      value={proposedOption}
                      onChange={(e) => setProposedOption(e.target.value as any)}
                      className="w-full text-xs font-semibold px-3 py-2 bg-white border border-slate-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-purple-600"
                    >
                      {(['A', 'B', 'C', 'D'] as const).map((opt) => (
                        <option key={opt} value={opt}>
                          Option {opt} ({activeChallengeQuestion.options[opt]})
                        </option>
                      ))}
                      <option value="All Options Invalid">All Options Invalid / Typo in Question</option>
                    </select>
                  </div>

                  <div>
                    <label className="block font-bold text-slate-700 uppercase tracking-wider mb-1">
                      Objection Category *
                    </label>
                    <select
                      value={objectionCategory}
                      onChange={(e) => setObjectionCategory(e.target.value as any)}
                      className="w-full text-xs font-semibold px-3 py-2 bg-white border border-slate-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-purple-600"
                    >
                      <option value="Incorrect Key">Incorrect Key (Alternate option is correct)</option>
                      <option value="Ambiguous Question">Ambiguous Question / Multiple Answers</option>
                      <option value="Out of Syllabus">Out of Prescribed Syllabus</option>
                      <option value="Typographical Discrepancy">Typographical / Translation Discrepancy</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block font-bold text-slate-700 uppercase tracking-wider mb-1">
                    Academic Justification / Proof * (min 15 chars)
                  </label>
                  <textarea
                    rows={3}
                    value={justification}
                    onChange={(e) => setJustification(e.target.value)}
                    placeholder="Explain step-by-step mathematical proof or chemical derivation proving why the key requires revision..."
                    className="w-full text-xs px-3 py-2 bg-white border border-slate-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-purple-600 text-slate-900"
                  />
                  <div className="text-right text-[10px] text-slate-400">{justification.length} characters</div>
                </div>

                <div>
                  <label className="block font-bold text-slate-700 uppercase tracking-wider mb-1">
                    Standard Reference Citation *
                  </label>
                  <input
                    type="text"
                    value={referenceSource}
                    onChange={(e) => setReferenceSource(e.target.value)}
                    placeholder="e.g., NCERT Class XII Physics, Chapter 4, Page 128, Formula 4.19"
                    className="w-full text-xs px-3 py-2 bg-white border border-slate-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-purple-600 text-slate-900 font-medium"
                  />
                </div>

                {/* File Upload Attachment */}
                <div>
                  <label className="block font-bold text-slate-700 uppercase tracking-wider mb-1">
                    Upload Supporting Document (PDF / JPG, Max 5MB)
                  </label>
                  <label className="border-2 border-dashed border-slate-300 hover:border-purple-500 rounded-xl p-3 flex flex-col items-center justify-center gap-1 cursor-pointer bg-slate-50 hover:bg-purple-50/30 transition-colors">
                    <Upload className="w-5 h-5 text-slate-400" />
                    <span className="text-[11px] font-semibold text-slate-700">
                      {uploadedDocName ? (
                        <span className="text-emerald-700 font-bold">Attached: {uploadedDocName}</span>
                      ) : (
                        'Click to browse textbook scan or handwritten derivation'
                      )}
                    </span>
                    <input
                      type="file"
                      accept=".pdf,.png,.jpg,.jpeg"
                      onChange={handleMockFileUpload}
                      className="hidden"
                    />
                  </label>
                </div>

                {/* Fee calculation box */}
                <div className="p-3 bg-purple-50 rounded-xl border border-purple-200 flex items-center justify-between">
                  <div>
                    <span className="font-bold text-purple-900 block text-xs">Standard Challenge Processing Fee:</span>
                    <span className="text-[11px] text-purple-700">
                      Fully refundable to candidate account if challenge is upheld.
                    </span>
                  </div>
                  <div className="text-base font-black text-purple-800">₹500 / $10</div>
                </div>

                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setActiveChallengeQuestion(null)}
                    className="px-4 py-2 border border-slate-300 rounded-lg text-slate-700 font-semibold"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white font-bold rounded-lg transition-colors flex items-center gap-1.5 shadow-xs"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>Pay Fee &amp; Submit Challenge</span>
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Modal Footer */}
        <div className="bg-slate-50 border-t border-slate-200 px-6 py-3.5 flex items-center justify-between text-xs text-slate-500">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-purple-600" />
            <span>All filed challenges undergo blind peer review by a 3-member National Expert Board.</span>
          </div>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-[#0B254E] hover:bg-[#071933] text-white rounded-lg text-xs font-bold transition-colors shadow-xs"
          >
            Close Portal
          </button>
        </div>
      </div>
    </div>
  );
};
