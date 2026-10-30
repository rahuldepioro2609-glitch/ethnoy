/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { X, CheckCircle2, ArrowRight, ArrowLeft, ShieldCheck, FileCheck } from 'lucide-react';
import { ExamItem } from '../data/portalData';

interface ExamApplyModalProps {
  exam: ExamItem | null;
  onClose: () => void;
  onApplicationComplete: (appNo: string) => void;
}

export const ExamApplyModal: React.FC<ExamApplyModalProps> = ({ exam, onClose, onApplicationComplete }) => {
  const [step, setStep] = useState(1);
  const [candidateName, setCandidateName] = useState('Aarav Sharma');
  const [email, setEmail] = useState('aarav.sharma@example.edu');
  const [phone, setPhone] = useState('+91-9876543210');
  const [prefCity1, setPrefCity1] = useState('New Delhi');
  const [prefCity2, setPrefCity2] = useState('Noida / Greater Noida');
  const [languageMedium, setLanguageMedium] = useState('English');
  const [generatedAppNo, setGeneratedAppNo] = useState<string | null>(null);

  if (!exam) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (step === 1) {
      setStep(2);
    } else if (step === 2) {
      const randomDigits = Math.floor(10000 + Math.random() * 90000);
      const appNo = `NEA-2026-${randomDigits}`;
      setGeneratedAppNo(appNo);
      setStep(3);
      onApplicationComplete(appNo);
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/75 backdrop-blur-xs flex items-center justify-center p-3 sm:p-6 animate-in fade-in duration-150">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-xl overflow-hidden my-6 flex flex-col">
        {/* Header */}
        <div className="bg-[#059669] text-white px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-emerald-800/40 rounded-lg">
              <FileCheck className="w-5 h-5 text-emerald-100" />
            </div>
            <div>
              <span className="text-[10px] font-mono uppercase tracking-wider text-emerald-100">
                Online Candidate Registration Window
              </span>
              <h2 className="text-sm font-bold truncate max-w-sm">
                {exam.name} ({exam.code})
              </h2>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-emerald-100 hover:text-white hover:bg-emerald-700 transition-colors"
            aria-label="Close application dialog"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Step Indicator */}
        <div className="bg-slate-50 border-b border-slate-200 px-6 py-3 flex items-center justify-between text-xs">
          <div className="flex items-center gap-2">
            <span
              className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                step >= 1 ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-600'
              }`}
            >
              1
            </span>
            <span className={step >= 1 ? 'font-bold text-slate-900' : 'text-slate-400'}>
              Candidate Info
            </span>
          </div>
          <span className="text-slate-300">———</span>
          <div className="flex items-center gap-2">
            <span
              className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                step >= 2 ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-600'
              }`}
            >
              2
            </span>
            <span className={step >= 2 ? 'font-bold text-slate-900' : 'text-slate-400'}>
              Center Preferences
            </span>
          </div>
          <span className="text-slate-300">———</span>
          <div className="flex items-center gap-2">
            <span
              className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                step >= 3 ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-600'
              }`}
            >
              3
            </span>
            <span className={step >= 3 ? 'font-bold text-slate-900' : 'text-slate-400'}>
              Confirmation
            </span>
          </div>
        </div>

        {/* Form Body */}
        <div className="p-6">
          {step === 1 && (
            <form onSubmit={handleSubmit} className="space-y-4 text-xs">
              <div className="p-3 bg-blue-50 rounded-xl border border-blue-200 text-blue-900 space-y-1">
                <span className="font-bold">Exam Details:</span>
                <div>Duration: {exam.duration} · Mode: {exam.mode}</div>
                <div>Standard Application Fee: <strong className="text-blue-950 font-mono">{exam.fee}</strong></div>
              </div>

              <div>
                <label htmlFor="exam-apply-name" className="block font-bold text-slate-700 uppercase tracking-wider mb-1">
                  Full Candidate Name (As in Class 10th Certificate)
                </label>
                <input
                  id="exam-apply-name"
                  type="text"
                  value={candidateName}
                  onChange={(e) => setCandidateName(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl font-semibold text-sm focus:ring-2 focus:ring-emerald-500 focus:outline-hidden uppercase"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="exam-apply-email" className="block font-bold text-slate-700 uppercase tracking-wider mb-1">
                    Email Address
                  </label>
                  <input
                    id="exam-apply-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                    required
                  />
                </div>
                <div>
                  <label htmlFor="exam-apply-phone" className="block font-bold text-slate-700 uppercase tracking-wider mb-1">
                    Mobile Number
                  </label>
                  <input
                    id="exam-apply-phone"
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                    required
                  />
                </div>
              </div>

              <div className="pt-3 flex justify-end">
                <button
                  type="submit"
                  className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl flex items-center gap-1.5 transition-colors shadow-sm"
                >
                  <span>Proceed to Center Choice</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </form>
          )}

          {step === 2 && (
            <form onSubmit={handleSubmit} className="space-y-4 text-xs">
              <div>
                <label htmlFor="exam-apply-pref-1" className="block font-bold text-slate-700 uppercase tracking-wider mb-1">
                  1st Choice Examination City
                </label>
                <select
                  id="exam-apply-pref-1"
                  value={prefCity1}
                  onChange={(e) => setPrefCity1(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl font-medium focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                >
                  <option value="New Delhi">New Delhi (National Capital Region)</option>
                  <option value="Mumbai">Mumbai (Western Zone)</option>
                  <option value="Bengaluru">Bengaluru (Southern Zone)</option>
                  <option value="Hyderabad">Hyderabad (Deccan Zone)</option>
                  <option value="Kolkata">Kolkata (Eastern Zone)</option>
                </select>
              </div>

              <div>
                <label htmlFor="exam-apply-pref-2" className="block font-bold text-slate-700 uppercase tracking-wider mb-1">
                  2nd Choice Examination City (Alternative)
                </label>
                <select
                  id="exam-apply-pref-2"
                  value={prefCity2}
                  onChange={(e) => setPrefCity2(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl font-medium focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                >
                  <option value="Noida / Greater Noida">Noida / Greater Noida</option>
                  <option value="Pune">Pune</option>
                  <option value="Chennai">Chennai</option>
                  <option value="Jaipur">Jaipur</option>
                </select>
              </div>

              <div>
                <label htmlFor="exam-apply-medium" className="block font-bold text-slate-700 uppercase tracking-wider mb-1">
                  Question Paper Medium / Language
                </label>
                <select
                  id="exam-apply-medium"
                  value={languageMedium}
                  onChange={(e) => setLanguageMedium(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl font-medium focus:ring-2 focus:ring-emerald-500 focus:outline-hidden"
                >
                  <option value="English">English</option>
                  <option value="Hindi">हिन्दी (Hindi)</option>
                  <option value="Regional Bilingual">Regional Bilingual (English + State Language)</option>
                </select>
              </div>

              <div className="pt-3 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold rounded-xl flex items-center gap-1 transition-colors"
                >
                  <ArrowLeft className="w-4 h-4" />
                  <span>Back</span>
                </button>
                <button
                  type="submit"
                  className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl flex items-center gap-1.5 transition-colors shadow-sm"
                >
                  <span>Submit Application</span>
                  <CheckCircle2 className="w-4 h-4" />
                </button>
              </div>
            </form>
          )}

          {step === 3 && generatedAppNo && (
            <div className="text-center py-4 space-y-4">
              <div className="w-14 h-14 bg-emerald-100 text-emerald-700 rounded-full flex items-center justify-center mx-auto">
                <CheckCircle2 className="w-8 h-8" />
              </div>
              <h3 className="text-lg font-extrabold text-slate-900">
                Application Successfully Submitted!
              </h3>
              <p className="text-xs text-slate-600 max-w-sm mx-auto">
                Your provisional registration for {exam.name} has been recorded in the central database.
              </p>

              <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 text-left text-xs space-y-2 max-w-md mx-auto">
                <div className="flex justify-between">
                  <span className="text-slate-500">Application Number:</span>
                  <strong className="font-mono text-emerald-700 text-sm">{generatedAppNo}</strong>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Candidate:</span>
                  <strong className="uppercase">{candidateName}</strong>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Primary Center:</span>
                  <strong>{prefCity1}</strong>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Status:</span>
                  <span className="text-emerald-700 font-bold bg-emerald-100 px-2 py-0.5 rounded">
                    Verified (Fee Paid)
                  </span>
                </div>
              </div>

              <div className="pt-2 flex justify-center gap-3">
                <button
                  onClick={onClose}
                  className="px-6 py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs rounded-xl transition-colors"
                >
                  Done
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
