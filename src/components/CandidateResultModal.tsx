/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
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
  lookupScorecard,
  formatRankDisplay,
  getCutoffComparison,
  CandidateScorecard,
  PRESET_SCORECARDS,
} from '../utils/resultLogic';

interface CandidateResultModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultRollNumber?: string;
}

export const CandidateResultModal: React.FC<CandidateResultModalProps> = ({
  isOpen,
  onClose,
  defaultRollNumber = 'ENT-2025-9981',
}) => {
  const [rollInput, setRollInput] = useState(defaultRollNumber);
  const [dobInput, setDobInput] = useState('2004-06-14');
  const [selectedExam, setSelectedExam] = useState('ENT-2025');
  const [activeScorecard, setActiveScorecard] = useState<CandidateScorecard | null>(() =>
    lookupScorecard(defaultRollNumber)
  );
  const [hasSearched, setHasSearched] = useState(true);
  const [isPrinting, setIsPrinting] = useState(false);

  if (!isOpen) return null;

  const handleSearch = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!rollInput.trim()) return;
    const result = lookupScorecard(rollInput, selectedExam);
    setActiveScorecard(result);
    setHasSearched(true);
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
                Candidate Result &amp; All-India Rank Card Portal
              </h2>
              <p className="text-xs text-sky-200">
                Official National Examination Results &amp; Merit Certification · ELTNOY Directorate
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-white/10 transition-colors"
            aria-label="Close Result Portal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Verification Form Strip */}
        <div className="bg-slate-50 border-b border-slate-200 p-4 sm:p-5">
          <form onSubmit={handleSearch} className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
            <div className="sm:col-span-4">
              <label htmlFor="res-roll" className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
                Roll No / Application No
              </label>
              <input
                id="res-roll"
                type="text"
                value={rollInput}
                onChange={(e) => setRollInput(e.target.value)}
                placeholder="e.g. ENT-2025-9981"
                className="w-full text-xs font-semibold px-3 py-2 bg-white border border-slate-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-[#16A34A] focus:border-transparent uppercase"
              />
            </div>

            <div className="sm:col-span-3">
              <label htmlFor="res-dob" className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
                Date of Birth
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
                Examination
              </label>
              <select
                id="res-exam"
                value={selectedExam}
                onChange={(e) => setSelectedExam(e.target.value)}
                className="w-full text-xs font-medium px-3 py-2 bg-white border border-slate-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-[#16A34A] focus:border-transparent"
              >
                <option value="ENT-2025">ELTNOY National Test (ENT-2025)</option>
                <option value="EST-2025">Scholarship Assessment (EST-2025)</option>
                <option value="ETET-2025">Teacher Eligibility Test (ETET-2025)</option>
              </select>
            </div>

            <div className="sm:col-span-2">
              <button
                type="submit"
                className="w-full py-2 px-3 bg-[#16A34A] hover:bg-[#15803D] text-white text-xs font-bold rounded-lg transition-colors flex items-center justify-center gap-1.5 shadow-xs"
              >
                <Search className="w-3.5 h-3.5" />
                <span>Search</span>
              </button>
            </div>
          </form>

          {/* Quick preset buttons for instant inspection */}
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-slate-500 font-medium">Demo Candidates:</span>
            {PRESET_SCORECARDS.map((preset) => (
              <button
                key={preset.rollNumber}
                type="button"
                onClick={() => {
                  setRollInput(preset.rollNumber);
                  setSelectedExam(preset.examCode);
                  setActiveScorecard(preset);
                }}
                className={`px-2.5 py-1 rounded-md text-[11px] font-semibold border transition-all ${
                  activeScorecard?.rollNumber === preset.rollNumber
                    ? 'bg-emerald-50 text-emerald-800 border-emerald-300 shadow-2xs'
                    : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-100'
                }`}
              >
                {preset.candidateName} ({preset.rollNumber})
              </button>
            ))}
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
                      <span className="text-xs font-black uppercase tracking-wider text-slate-500">Official Scorecard</span>
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800">
                        <ShieldCheck className="w-3 h-3 text-emerald-600" />
                        Verified Digital Certificate
                      </span>
                    </div>
                    <h3 className="text-lg font-black text-[#0B254E] tracking-tight">{activeScorecard.examName}</h3>
                    <div className="text-xs text-slate-500">
                      Conducted on: {activeScorecard.examDate} · Issue Date: {activeScorecard.issueDate}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-3 self-end sm:self-auto">
                  <div className="text-right hidden sm:block">
                    <div className="text-[11px] font-mono text-slate-400">Security Ref:</div>
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
                  <span className="text-slate-400 font-medium block">Candidate Name</span>
                  <span className="font-bold text-slate-900 text-sm">{activeScorecard.candidateName}</span>
                </div>
                <div>
                  <span className="text-slate-400 font-medium block">Roll Number</span>
                  <span className="font-bold font-mono text-slate-900">{activeScorecard.rollNumber}</span>
                </div>
                <div>
                  <span className="text-slate-400 font-medium block">Application No</span>
                  <span className="font-bold font-mono text-slate-900">{activeScorecard.applicationNumber}</span>
                </div>
                <div>
                  <span className="text-slate-400 font-medium block">Category &amp; PwD</span>
                  <span className="font-bold text-slate-900">{activeScorecard.category} {activeScorecard.pwdStatus ? '(PwD)' : ''}</span>
                </div>

                <div>
                  <span className="text-slate-400 font-medium block">Father's Name</span>
                  <span className="font-semibold text-slate-800">{activeScorecard.fatherName}</span>
                </div>
                <div>
                  <span className="text-slate-400 font-medium block">Mother's Name</span>
                  <span className="font-semibold text-slate-800">{activeScorecard.motherName}</span>
                </div>
                <div>
                  <span className="text-slate-400 font-medium block">Date of Birth</span>
                  <span className="font-semibold text-slate-800">{activeScorecard.dob}</span>
                </div>
                <div>
                  <span className="text-slate-400 font-medium block">Exam Center</span>
                  <span className="font-semibold text-slate-800 truncate block" title={activeScorecard.centerName}>
                    {activeScorecard.centerName}
                  </span>
                </div>
              </div>

              {/* High Impact Highlights: AIR, Category Rank, Percentile, Qualification Status */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 py-4">
                <div className="bg-sky-50 border border-sky-100 rounded-xl p-3 text-center">
                  <div className="text-[11px] font-bold text-sky-700 uppercase tracking-wider">All-India Rank (AIR)</div>
                  <div className="text-2xl font-black text-[#0B254E] mt-0.5">
                    {formatRankDisplay(activeScorecard.allIndiaRank, '')}
                  </div>
                  <div className="text-[10px] text-sky-600 font-semibold mt-1 flex items-center justify-center gap-1">
                    <TrendingUp className="w-3 h-3" /> Top 0.1% National
                  </div>
                </div>

                <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-3 text-center">
                  <div className="text-[11px] font-bold text-emerald-800 uppercase tracking-wider">Category Rank</div>
                  <div className="text-2xl font-black text-emerald-700 mt-0.5">
                    {formatRankDisplay(activeScorecard.categoryRank, '')}
                  </div>
                  <div className="text-[10px] text-emerald-600 font-medium mt-1">
                    Category: {activeScorecard.category}
                  </div>
                </div>

                <div className="bg-purple-50 border border-purple-100 rounded-xl p-3 text-center">
                  <div className="text-[11px] font-bold text-purple-800 uppercase tracking-wider">National Percentile</div>
                  <div className="text-2xl font-black text-purple-700 mt-0.5">
                    {activeScorecard.aggregatePercentile}%
                  </div>
                  <div className="text-[10px] text-purple-600 font-medium mt-1">
                    NTA/ELT Normalised Score
                  </div>
                </div>

                <div className="bg-amber-50 border border-amber-100 rounded-xl p-3 text-center">
                  <div className="text-[11px] font-bold text-amber-800 uppercase tracking-wider">Status</div>
                  <div className="text-sm font-black text-emerald-700 mt-1 flex items-center justify-center gap-1">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                    <span>QUALIFIED</span>
                  </div>
                  <div className="text-[10px] text-amber-700 font-medium mt-1">
                    Seat Allocation Eligible
                  </div>
                </div>
              </div>

              {/* Sectional Score Breakdown Table */}
              <div className="mt-2">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
                    <FileText className="w-4 h-4 text-emerald-600" />
                    Sectional Score Breakdown &amp; Sub-Subject Percentiles
                  </h4>
                  <span className="text-[11px] text-slate-500">Marking Scheme: +4 Correct / -1 Incorrect</span>
                </div>

                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="w-full text-xs text-left">
                    <thead className="bg-slate-100 text-slate-700 font-bold uppercase tracking-wider text-[11px]">
                      <tr>
                        <th className="py-2.5 px-3">Subject / Paper Section</th>
                        <th className="py-2.5 px-3 text-center">Max Marks</th>
                        <th className="py-2.5 px-3 text-center">Marks Obtained</th>
                        <th className="py-2.5 px-3 text-center">Section Percentile</th>
                        <th className="py-2.5 px-3 text-center">Performance Indicator</th>
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
                            <span className="inline-block px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800">
                              Excellent (Band A+)
                            </span>
                          </td>
                        </tr>
                      ))}
                      <tr className="bg-slate-100 font-bold text-slate-900">
                        <td className="py-3 px-3">Grand Aggregate Total</td>
                        <td className="py-3 px-3 text-center font-mono">{activeScorecard.totalMaxMarks}</td>
                        <td className="py-3 px-3 text-center font-mono text-base text-[#15803D]">
                          {activeScorecard.totalMarksObtained}
                        </td>
                        <td className="py-3 px-3 text-center font-mono text-base text-[#0B254E]">
                          {activeScorecard.aggregatePercentile}%
                        </td>
                        <td className="py-3 px-3 text-center text-xs text-emerald-700">All India Merit Valid</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Cut-off Analysis & Counseling Stream Box */}
              <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="p-4 rounded-xl border border-slate-200 bg-slate-50 text-xs space-y-2">
                  <div className="font-bold text-slate-800 flex items-center justify-between">
                    <span>Category Cut-off Verification</span>
                    <span className="text-emerald-700 font-bold">
                      Cut-off: {cutoffComp?.categoryCutoff} Marks
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
                    <span>Your Marks: {activeScorecard.totalMarksObtained}</span>
                    <span className="text-emerald-700 font-semibold">
                      +{cutoffComp?.margin} above {activeScorecard.category} cutoff
                    </span>
                  </div>
                </div>

                <div className="p-4 rounded-xl border border-emerald-200 bg-emerald-50/60 text-xs space-y-1.5">
                  <div className="font-bold text-emerald-900 flex items-center gap-1.5">
                    <Sparkles className="w-4 h-4 text-emerald-600" />
                    <span>Counseling Stream &amp; Recommendation</span>
                  </div>
                  <p className="text-emerald-800 font-medium">
                    {activeScorecard.counselingStream}
                  </p>
                  <p className="text-[11px] text-slate-600">
                    Registration for Phase-1 Central Choice Filling begins 10 July 2025 on the ELTNOY Counseling Portal.
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="py-12 text-center text-slate-500 text-sm">
              Enter your Roll Number and Date of Birth to view your scorecard.
            </div>
          )}
        </div>

        {/* Modal Actions Footer */}
        <div className="bg-slate-50 border-t border-slate-200 px-6 py-3.5 flex flex-wrap items-center justify-between gap-3">
          <div className="text-[11px] text-slate-500 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-[#16A34A]" />
            <span>Digital Scorecard cryptographically signed by ELTNOY Board of Examinations.</span>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 border border-slate-300 hover:bg-slate-100 rounded-lg text-xs font-semibold text-slate-700 transition-colors"
            >
              Close
            </button>
            <button
              onClick={handlePrint}
              disabled={!activeScorecard}
              className="px-4 py-2 bg-[#0B254E] hover:bg-[#071933] text-white rounded-lg text-xs font-bold transition-colors flex items-center gap-2 shadow-xs disabled:opacity-50"
            >
              <Printer className="w-3.5 h-3.5" />
              <span>{isPrinting ? 'Preparing Print...' : 'Download / Print Scorecard'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
