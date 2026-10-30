/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import {
  X,
  Clock,
  Calculator,
  CheckCircle,
  HelpCircle,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  Send,
  Award,
  BookOpen,
} from 'lucide-react';
import { MOCK_QUESTIONS } from '../data/portalData';
import { apiRequest } from '../api';
import {
  MockQuestion,
  QuestionResponseState,
  calculateExamScore,
  ExamScoreResult,
} from '../utils/examLogic';

interface CbtMockExamModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const CbtMockExamModal: React.FC<CbtMockExamModalProps> = ({ isOpen, onClose }) => {
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [selectedSection, setSelectedSection] = useState<string>('Physics');
  const [responses, setResponses] = useState<Record<number, QuestionResponseState>>({});
  const [timeLeftSeconds, setTimeLeftSeconds] = useState(900); // 15 minutes
  const [isExamSubmitted, setIsExamSubmitted] = useState(false);
  const [scoreResult, setScoreResult] = useState<ExamScoreResult | null>(null);
  const [showCalculator, setShowCalculator] = useState(false);
  const [calcInput, setCalcInput] = useState('');
  const [calcResult, setCalcResult] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Sections list
  const sections = ['Physics', 'Chemistry', 'Mathematics', 'General Aptitude'];

  // Timer effect
  useEffect(() => {
    if (!isOpen || isExamSubmitted) return;
    const interval = setInterval(() => {
      setTimeLeftSeconds((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          handleSubmitExam();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [isOpen, isExamSubmitted]);

  // Mark first question visited on load
  useEffect(() => {
    if (isOpen) {
      const q = MOCK_QUESTIONS[0];
      setResponses((prev) => ({
        ...prev,
        [q.id]: {
          ...prev[q.id],
          visited: true,
          isMarkedForReview: prev[q.id]?.isMarkedForReview || false,
        },
      }));
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const currentQ: MockQuestion = MOCK_QUESTIONS[currentQuestionIndex];
  const currentResp = responses[currentQ.id] || { visited: true, isMarkedForReview: false };

  // Timer format (MM:SS)
  const formatTime = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const s = secs % 60;
    return `${mins.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const handleSelectOption = (optId: string) => {
    setResponses((prev) => ({
      ...prev,
      [currentQ.id]: {
        ...prev[currentQ.id],
        selectedOptionId: optId,
        visited: true,
      },
    }));
  };

  const handleClearResponse = () => {
    setResponses((prev) => {
      const copy = { ...prev };
      if (copy[currentQ.id]) {
        delete copy[currentQ.id].selectedOptionId;
      }
      return copy;
    });
  };

  const handleToggleMarkForReview = () => {
    setResponses((prev) => ({
      ...prev,
      [currentQ.id]: {
        ...prev[currentQ.id],
        visited: true,
        isMarkedForReview: !prev[currentQ.id]?.isMarkedForReview,
      },
    }));
    handleNextQuestion();
  };

  const handleNextQuestion = () => {
    if (currentQuestionIndex < MOCK_QUESTIONS.length - 1) {
      const nextIndex = currentQuestionIndex + 1;
      const nextQ = MOCK_QUESTIONS[nextIndex];
      setCurrentQuestionIndex(nextIndex);
      setSelectedSection(nextQ.section);
      setResponses((prev) => ({
        ...prev,
        [nextQ.id]: {
          ...prev[nextQ.id],
          visited: true,
          isMarkedForReview: prev[nextQ.id]?.isMarkedForReview || false,
        },
      }));
    }
  };

  const handlePrevQuestion = () => {
    if (currentQuestionIndex > 0) {
      const prevIndex = currentQuestionIndex - 1;
      const prevQ = MOCK_QUESTIONS[prevIndex];
      setCurrentQuestionIndex(prevIndex);
      setSelectedSection(prevQ.section);
    }
  };

  const handleJumpToQuestion = (idx: number) => {
    setCurrentQuestionIndex(idx);
    const targetQ = MOCK_QUESTIONS[idx];
    setSelectedSection(targetQ.section);
    setResponses((prev) => ({
      ...prev,
      [targetQ.id]: {
        ...prev[targetQ.id],
        visited: true,
        isMarkedForReview: prev[targetQ.id]?.isMarkedForReview || false,
      },
    }));
  };

  const handleSubmitExam = async () => {
    if (isSubmitting || isExamSubmitted) return;
    setIsSubmitting(true);
    setSubmitError(null);
    const localScore = calculateExamScore(MOCK_QUESTIONS, responses);
    try {
      const { score } = await apiRequest<{ score: ExamScoreResult }>('/api/mock-exams/submit', {
        method: 'POST',
        body: JSON.stringify({ responses }),
      });
      setScoreResult(score);
    } catch (error) {
      setScoreResult(localScore);
      setSubmitError(error instanceof Error
        ? `Result shown locally; the attempt was not saved: ${error.message}`
        : 'Result shown locally; the attempt was not saved.');
    } finally {
      setIsSubmitting(false);
      setIsExamSubmitted(true);
    }
  };

  const handleResetExam = () => {
    setResponses({});
    setTimeLeftSeconds(900);
    setCurrentQuestionIndex(0);
    setSelectedSection('Physics');
    setIsExamSubmitted(false);
    setScoreResult(null);
    setSubmitError(null);
  };

  // Status helper for question palette
  const getQuestionStatus = (q: MockQuestion) => {
    const resp = responses[q.id];
    if (!resp || !resp.visited) return 'not-visited';
    if (resp.selectedOptionId && resp.isMarkedForReview) return 'answered-review';
    if (resp.isMarkedForReview) return 'review';
    if (resp.selectedOptionId) return 'answered';
    return 'not-answered';
  };

  // Safe simple calculator
  const handleCalcClick = (val: string) => {
    if (val === 'C') {
      setCalcInput('');
      setCalcResult('');
    } else if (val === '=') {
      try {
        // Simple safe arithmetic evaluation of basic numbers and operators
        const sanitized = calcInput.replace(/[^0-9+\-*/.]/g, '');
        // eslint-disable-next-line no-eval
        const res = Function(`"use strict"; return (${sanitized})`)();
        setCalcResult(String(res));
      } catch {
        setCalcResult('Error');
      }
    } else {
      setCalcInput((prev) => prev + val);
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-slate-900/80 backdrop-blur-xs flex items-center justify-center p-2 sm:p-4">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-300 w-full max-w-6xl h-[92vh] flex flex-col overflow-hidden">
        {/* CBT Navigation Header */}
        <div className="bg-[#0F172A] text-white px-4 sm:px-6 py-3 flex items-center justify-between border-b border-slate-800 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded bg-emerald-600 flex items-center justify-center font-bold text-xs">
              CBT
            </div>
            <div>
              <div className="text-xs sm:text-sm font-bold flex items-center gap-2">
                <span>National CBT Mock Exam Simulator 2026</span>
                <span className="hidden sm:inline-block px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-950 text-emerald-400 border border-emerald-700">
                  Marking Scheme: +4 / -1
                </span>
              </div>
              <div className="text-[11px] text-slate-400">
                Candidate: <strong>AARAV SHARMA (NEA-2026-88419)</strong> · Node: CBT-TERM-04
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Live Countdown Timer */}
            <div
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border font-mono font-bold text-sm ${
                timeLeftSeconds < 180
                  ? 'bg-rose-950/80 text-rose-300 border-rose-700 animate-pulse'
                  : 'bg-slate-800 text-emerald-400 border-slate-700'
              }`}
              title="Time Remaining"
            >
              <Clock className="w-4 h-4 text-emerald-400" />
              <span>{formatTime(timeLeftSeconds)}</span>
            </div>

            {/* Calculator button */}
            <button
              onClick={() => setShowCalculator((prev) => !prev)}
              className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg border border-slate-700 transition-colors"
              title="Toggle Scientific Calculator"
              aria-label="Calculator"
            >
              <Calculator className="w-4 h-4" />
            </button>

            {/* Close Button */}
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              aria-label="Exit CBT Examination"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {!isExamSubmitted ? (
          /* Active Examination Interface */
          <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
            {/* Left 70%: Question & Options Stage */}
            <div className="flex-1 flex flex-col border-r border-slate-200 bg-white overflow-y-auto">
              {/* Section Tabs */}
              <div className="bg-slate-100 border-b border-slate-200 px-4 py-2 flex items-center gap-2 overflow-x-auto text-xs shrink-0">
                <span className="font-bold text-slate-500 uppercase text-[10px] mr-1">
                  Sections:
                </span>
                {sections.map((sec) => (
                  <button
                    key={sec}
                    onClick={() => {
                      setSelectedSection(sec);
                      const firstQSec = MOCK_QUESTIONS.findIndex((q) => q.section === sec);
                      if (firstQSec !== -1) {
                        handleJumpToQuestion(firstQSec);
                      }
                    }}
                    className={`px-3 py-1.5 rounded-lg font-bold text-xs whitespace-nowrap transition-colors ${
                      selectedSection === sec
                        ? 'bg-blue-900 text-white shadow-2xs'
                        : 'text-slate-700 bg-white hover:bg-slate-200/80 border border-slate-200'
                    }`}
                  >
                    {sec}
                  </button>
                ))}
              </div>

              {/* Question Header */}
              <div className="px-6 py-3 border-b border-slate-100 bg-slate-50/70 flex items-center justify-between text-xs shrink-0">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-slate-900 text-sm">
                    Question {currentQuestionIndex + 1} of {MOCK_QUESTIONS.length}
                  </span>
                  <span className="text-slate-400">|</span>
                  <span className="font-semibold text-blue-700 bg-blue-50 px-2 py-0.5 rounded border border-blue-200">
                    {currentQ.section}
                  </span>
                </div>
                <div className="flex items-center gap-2 font-mono text-[11px]">
                  <span className="text-emerald-700 font-bold">+4.00</span>
                  <span className="text-slate-400">/</span>
                  <span className="text-rose-600 font-bold">-1.00</span>
                </div>
              </div>

              {/* Question Body */}
              <div className="p-6 flex-1 space-y-6">
                <div className="text-sm sm:text-base font-semibold text-slate-900 leading-relaxed select-none">
                  {currentQ.questionText}
                </div>

                {/* Options List */}
                <div className="space-y-3 pt-2">
                  {currentQ.options.map((option) => {
                    const isSelected = currentResp.selectedOptionId === option.id;
                    return (
                      <label
                        key={option.id}
                        onClick={() => handleSelectOption(option.id)}
                        className={`flex items-start gap-3.5 p-3.5 rounded-xl border cursor-pointer transition-all ${
                          isSelected
                            ? 'bg-blue-50/80 border-blue-600 text-blue-950 font-semibold shadow-xs ring-1 ring-blue-500'
                            : 'bg-white border-slate-200 hover:bg-slate-50 text-slate-800'
                        }`}
                      >
                        <input
                          type="radio"
                          name={`question-${currentQ.id}`}
                          checked={isSelected}
                          onChange={() => handleSelectOption(option.id)}
                          className="w-4 h-4 text-blue-600 mt-0.5 cursor-pointer"
                        />
                        <div className="flex items-center gap-2 text-sm leading-snug">
                          <span className="w-5 h-5 rounded-full bg-slate-100 text-slate-700 text-xs font-bold flex items-center justify-center shrink-0 border border-slate-200">
                            {option.id}
                          </span>
                          <span>{option.text}</span>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>

              {/* Bottom Action Bar */}
              <div className="p-4 bg-slate-50 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2 shrink-0">
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleToggleMarkForReview}
                    className="px-3.5 py-2 bg-purple-50 text-purple-700 hover:bg-purple-100 border border-purple-200 rounded-lg text-xs font-bold transition-colors"
                  >
                    {currentResp.isMarkedForReview ? 'Unmark Review' : 'Mark for Review & Next'}
                  </button>
                  <button
                    onClick={handleClearResponse}
                    className="px-3 py-2 bg-white text-slate-600 hover:text-slate-900 border border-slate-300 rounded-lg text-xs font-semibold transition-colors"
                  >
                    Clear Response
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={handlePrevQuestion}
                    disabled={currentQuestionIndex === 0}
                    className="px-3 py-2 bg-white text-slate-700 hover:bg-slate-100 disabled:opacity-40 border border-slate-300 rounded-lg text-xs font-bold flex items-center gap-1 transition-colors"
                  >
                    <ChevronLeft className="w-4 h-4" />
                    <span>Previous</span>
                  </button>
                  <button
                    onClick={handleNextQuestion}
                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold flex items-center gap-1 transition-colors shadow-2xs"
                  >
                    <span>Save &amp; Next</span>
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>

            {/* Right 30%: Question Palette & Overview */}
            <div className="w-full md:w-80 bg-slate-50 flex flex-col p-4 border-t md:border-t-0 overflow-y-auto">
              <div className="pb-3 border-b border-slate-200">
                <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider">
                  Question Palette
                </h3>
                <p className="text-[11px] text-slate-500">
                  Click any question node to jump directly
                </p>
              </div>

              {/* Color Code Legend */}
              <div className="grid grid-cols-2 gap-2 my-3 text-[11px] text-slate-700">
                <div className="flex items-center gap-1.5">
                  <span className="w-5 h-5 rounded-md bg-emerald-600 text-white font-bold text-[10px] flex items-center justify-center">
                    4
                  </span>
                  <span>Answered</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-5 h-5 rounded-md bg-rose-600 text-white font-bold text-[10px] flex items-center justify-center">
                    2
                  </span>
                  <span>Not Answered</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-5 h-5 rounded-md bg-purple-600 text-white font-bold text-[10px] flex items-center justify-center">
                    1
                  </span>
                  <span>Marked Review</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-5 h-5 rounded-md bg-slate-200 text-slate-600 font-bold text-[10px] flex items-center justify-center border border-slate-300">
                    1
                  </span>
                  <span>Not Visited</span>
                </div>
              </div>

              {/* Question Buttons Matrix */}
              <div className="grid grid-cols-4 sm:grid-cols-4 gap-2 my-2">
                {MOCK_QUESTIONS.map((q, idx) => {
                  const status = getQuestionStatus(q);
                  const isCurrent = idx === currentQuestionIndex;

                  let style = 'bg-slate-200 text-slate-700 hover:bg-slate-300';
                  if (status === 'answered') style = 'bg-emerald-600 text-white';
                  if (status === 'not-answered') style = 'bg-rose-600 text-white';
                  if (status === 'review') style = 'bg-purple-600 text-white';
                  if (status === 'answered-review') style = 'bg-purple-700 text-white ring-2 ring-emerald-400';

                  return (
                    <button
                      key={q.id}
                      onClick={() => handleJumpToQuestion(idx)}
                      className={`h-10 rounded-lg text-xs font-bold flex items-center justify-center transition-all ${style} ${
                        isCurrent ? 'ring-2 ring-blue-900 ring-offset-2 scale-105' : ''
                      }`}
                    >
                      {idx + 1}
                    </button>
                  );
                })}
              </div>

              {/* Submit Test Button */}
              <div className="mt-auto pt-4 border-t border-slate-200">
                <button
                  onClick={handleSubmitExam}
                  disabled={isSubmitting}
                  className="w-full py-3 bg-blue-900 hover:bg-blue-800 active:bg-blue-950 disabled:opacity-60 text-white font-bold text-xs rounded-xl shadow-md flex items-center justify-center gap-2 transition-colors uppercase tracking-wider"
                >
                  <Send className="w-4 h-4" />
                  <span>{isSubmitting ? 'Saving attempt…' : 'Submit CBT Examination'}</span>
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* Submission Results & Score Analysis */
          scoreResult && (
            <div className="p-6 overflow-y-auto flex-1 space-y-6">
              {submitError && (
                <div role="alert" className="max-w-2xl mx-auto p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-xs">
                  {submitError}
                </div>
              )}
              <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-6 text-center max-w-2xl mx-auto space-y-3">
                <div className="w-14 h-14 bg-emerald-600 text-white rounded-full flex items-center justify-center mx-auto shadow-md">
                  <Award className="w-8 h-8" />
                </div>
                <h3 className="text-xl font-extrabold text-slate-900">
                  CBT Mock Examination Completed!
                </h3>
                <p className="text-xs text-slate-600">
                  Automated evaluation computed via official marking formula (+4 for correct, -1 for incorrect, 0 for unattempted).
                </p>

                {/* Score Big Display */}
                <div className="py-3 flex items-center justify-center gap-8 border-y border-emerald-200/80">
                  <div>
                    <span className="text-xs text-slate-500 uppercase block font-semibold">
                      Candidate Score
                    </span>
                    <span className="text-3xl font-extrabold text-emerald-800 font-mono">
                      {scoreResult.totalScore} / {scoreResult.maxScore}
                    </span>
                  </div>
                  <div className="border-l border-emerald-200 pl-8">
                    <span className="text-xs text-slate-500 uppercase block font-semibold">
                      Accuracy / Percentile
                    </span>
                    <span className="text-3xl font-extrabold text-blue-800 font-mono">
                      {scoreResult.percentage}%
                    </span>
                  </div>
                </div>

                {/* Metrics Breakdown */}
                <div className="grid grid-cols-4 gap-3 text-xs pt-2">
                  <div className="p-2.5 rounded-lg bg-white border border-slate-200">
                    <span className="text-slate-400 block text-[10px]">Attempted</span>
                    <strong className="text-slate-800 text-base">{scoreResult.attempted}</strong>
                  </div>
                  <div className="p-2.5 rounded-lg bg-emerald-100/60 border border-emerald-200">
                    <span className="text-emerald-700 block text-[10px]">Correct (+4)</span>
                    <strong className="text-emerald-900 text-base">{scoreResult.correct}</strong>
                  </div>
                  <div className="p-2.5 rounded-lg bg-rose-100/60 border border-rose-200">
                    <span className="text-rose-700 block text-[10px]">Incorrect (-1)</span>
                    <strong className="text-rose-900 text-base">{scoreResult.incorrect}</strong>
                  </div>
                  <div className="p-2.5 rounded-lg bg-white border border-slate-200">
                    <span className="text-slate-400 block text-[10px]">Unattempted</span>
                    <strong className="text-slate-700 text-base">{scoreResult.unattempted}</strong>
                  </div>
                </div>

                <div className="pt-4 flex items-center justify-center gap-3">
                  <button
                    onClick={handleResetExam}
                    className="px-5 py-2.5 bg-blue-900 hover:bg-blue-800 text-white rounded-xl text-xs font-bold flex items-center gap-2 transition-colors shadow-sm"
                  >
                    <RotateCcw className="w-4 h-4" />
                    <span>Retake Mock Exam</span>
                  </button>
                  <button
                    onClick={onClose}
                    className="px-5 py-2.5 bg-slate-200 hover:bg-slate-300 text-slate-800 rounded-xl text-xs font-bold transition-colors"
                  >
                    Close &amp; Return to Portal
                  </button>
                </div>
              </div>

              {/* Detailed Answer Key & Explanations */}
              <div className="max-w-4xl mx-auto space-y-4 pt-4 border-t border-slate-200">
                <h4 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <BookOpen className="w-4 h-4 text-blue-700" />
                  <span>Subject Expert Review &amp; Solution Key</span>
                </h4>

                <div className="space-y-3">
                  {MOCK_QUESTIONS.map((q, idx) => {
                    const userResp = responses[q.id]?.selectedOptionId;
                    const isCorrect = userResp === q.correctOptionId;
                    const isAttempted = !!userResp;

                    return (
                      <div
                        key={q.id}
                        className={`p-4 rounded-xl border text-xs space-y-2 ${
                          !isAttempted
                            ? 'bg-slate-50 border-slate-200'
                            : isCorrect
                            ? 'bg-emerald-50/50 border-emerald-200'
                            : 'bg-rose-50/50 border-rose-200'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-bold text-slate-900">
                            Q{idx + 1}. ({q.section})
                          </span>
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                              !isAttempted
                                ? 'bg-slate-200 text-slate-700'
                                : isCorrect
                                ? 'bg-emerald-600 text-white'
                                : 'bg-rose-600 text-white'
                            }`}
                          >
                            {!isAttempted ? 'Unattempted (0)' : isCorrect ? 'Correct (+4)' : 'Incorrect (-1)'}
                          </span>
                        </div>
                        <p className="font-medium text-slate-800">{q.questionText}</p>
                        <div className="grid grid-cols-2 gap-2 text-[11px]">
                          <div>
                            <span className="text-slate-500">Your Answer: </span>
                            <strong className={isCorrect ? 'text-emerald-700' : 'text-rose-600'}>
                              {userResp || 'None'}
                            </strong>
                          </div>
                          <div>
                            <span className="text-slate-500">Correct Option: </span>
                            <strong className="text-emerald-700">{q.correctOptionId}</strong>
                          </div>
                        </div>
                        <div className="bg-white p-2.5 rounded-lg border border-slate-200 text-slate-600 leading-relaxed text-[11px]">
                          <strong>Explanation: </strong> {q.explanation}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )
        )}

        {/* Embedded Calculator Dialog */}
        {showCalculator && (
          <div className="absolute top-16 right-6 z-50 bg-slate-900 text-white rounded-xl shadow-2xl border border-slate-700 p-4 w-64 animate-in fade-in zoom-in-95">
            <div className="flex items-center justify-between pb-2 border-b border-slate-800">
              <span className="text-xs font-bold flex items-center gap-1.5">
                <Calculator className="w-3.5 h-3.5 text-emerald-400" />
                <span>CBT On-Screen Calculator</span>
              </span>
              <button
                onClick={() => setShowCalculator(false)}
                className="text-slate-400 hover:text-white"
                aria-label="Close calculator"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="my-3 bg-black p-2 rounded text-right font-mono">
              <div className="text-[11px] text-slate-400 h-4 truncate">{calcInput || '0'}</div>
              <div className="text-lg font-bold text-emerald-400 h-6 truncate">{calcResult || ' '}</div>
            </div>

            <div className="grid grid-cols-4 gap-1.5 text-xs font-bold">
              {['7', '8', '9', '/', '4', '5', '6', '*', '1', '2', '3', '-', '0', '.', '=', '+', 'C'].map((b) => (
                <button
                  key={b}
                  onClick={() => handleCalcClick(b)}
                  className={`p-2 rounded transition-colors ${
                    b === 'C'
                      ? 'bg-rose-800 hover:bg-rose-700 col-span-2'
                      : b === '='
                      ? 'bg-emerald-600 hover:bg-emerald-500'
                      : 'bg-slate-800 hover:bg-slate-700 text-slate-200'
                  }`}
                >
                  {b}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
