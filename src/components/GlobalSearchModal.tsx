/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { Search, X, FileText, Calendar, Building2, ExternalLink, ArrowRight } from 'lucide-react';
import { TEST_CENTERS, ExamItem, NoticeItem, TestCenter } from '../data/portalData';

interface GlobalSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectExam: (exam: ExamItem) => void;
  onSelectNotice: (notice: NoticeItem) => void;
  onOpenAdmitCard: () => void;
  onOpenMockExam: () => void;
  examinations: ExamItem[];
  notices: NoticeItem[];
}

export const GlobalSearchModal: React.FC<GlobalSearchModalProps> = ({
  isOpen,
  onClose,
  onSelectExam,
  onSelectNotice,
  onOpenAdmitCard,
  onOpenMockExam,
  examinations,
  notices,
}) => {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setQuery('');
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const q = query.trim().toLowerCase();

  const matchedExams = examinations.filter(
    (e) =>
      e.name.toLowerCase().includes(q) ||
      e.code.toLowerCase().includes(q) ||
      e.category.toLowerCase().includes(q) ||
      e.targetAudience.toLowerCase().includes(q)
  );

  const matchedNotices = notices.filter(
    (n) =>
      n.title.toLowerCase().includes(q) ||
      n.refNo.toLowerCase().includes(q) ||
      n.category.toLowerCase().includes(q) ||
      n.summary.toLowerCase().includes(q)
  );

  const matchedCenters = TEST_CENTERS.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      c.code.toLowerCase().includes(q) ||
      c.city.toLowerCase().includes(q) ||
      c.state.toLowerCase().includes(q)
  );

  const totalResults = matchedExams.length + matchedNotices.length + matchedCenters.length;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/75 backdrop-blur-xs flex items-start justify-center p-3 sm:p-6 pt-16 sm:pt-20 animate-in fade-in duration-150">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-300 w-full max-w-2xl overflow-hidden flex flex-col">
        {/* Search Input Bar */}
        <div className="p-4 border-b border-slate-200 flex items-center gap-3 bg-slate-50">
          <Search className="w-5 h-5 text-slate-400 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search test code (NEE-2026, CMET), circular, admit card, or center..."
            className="w-full bg-transparent text-sm sm:text-base font-medium text-slate-900 placeholder:text-slate-400 outline-none"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="text-xs text-slate-400 hover:text-slate-600 px-1"
            >
              Clear
            </button>
          )}
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200 transition-colors"
            aria-label="Close search"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Quick Suggestion Chips */}
        <div className="px-4 py-2 border-b border-slate-100 bg-white flex items-center gap-1.5 overflow-x-auto text-xs">
          <span className="text-slate-400 font-medium text-[11px] mr-1">Popular:</span>
          {['NEE-2026', 'Admit Card', 'CMET-2026', 'Biometric', 'Mock Test', 'Delhi'].map((chip) => (
            <button
              key={chip}
              onClick={() => setQuery(chip)}
              className="px-2 py-0.5 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-700 text-[11px] font-semibold whitespace-nowrap transition-colors"
            >
              {chip}
            </button>
          ))}
        </div>

        {/* Results Area */}
        <div className="max-h-[60vh] overflow-y-auto p-4 space-y-4 divide-y divide-slate-100">
          {/* Quick Direct Actions */}
          <div>
            <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">
              Instant Portals
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => {
                  onClose();
                  onOpenAdmitCard();
                }}
                className="p-2.5 rounded-xl border border-blue-200 bg-blue-50/60 hover:bg-blue-100/70 text-left transition-colors flex items-center justify-between"
              >
                <div>
                  <div className="text-xs font-bold text-blue-900">Download Admit Card</div>
                  <div className="text-[10px] text-blue-700">Lookup by Application &amp; DOB</div>
                </div>
                <ArrowRight className="w-4 h-4 text-blue-600" />
              </button>

              <button
                onClick={() => {
                  onClose();
                  onOpenMockExam();
                }}
                className="p-2.5 rounded-xl border border-emerald-200 bg-emerald-50/60 hover:bg-emerald-100/70 text-left transition-colors flex items-center justify-between"
              >
                <div>
                  <div className="text-xs font-bold text-emerald-900">Launch CBT Mock Exam</div>
                  <div className="text-[10px] text-emerald-700">Timed 4-section practice</div>
                </div>
                <ArrowRight className="w-4 h-4 text-emerald-600" />
              </button>
            </div>
          </div>

          {/* Matched Exams */}
          {matchedExams.length > 0 && (
            <div className="pt-3">
              <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2 flex items-center justify-between">
                <span>Examinations ({matchedExams.length})</span>
                <Calendar className="w-3.5 h-3.5 text-slate-400" />
              </div>
              <div className="space-y-1.5">
                {matchedExams.map((e) => (
                  <button
                    key={e.id}
                    onClick={() => {
                      onClose();
                      onSelectExam(e);
                    }}
                    className="w-full text-left p-2.5 rounded-xl hover:bg-slate-50 transition-colors flex items-center justify-between group border border-slate-100 hover:border-slate-200"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-extrabold text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded">
                          {e.code}
                        </span>
                        <span className="text-xs font-bold text-slate-900 group-hover:text-blue-700">
                          {e.name}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        {e.targetAudience} · Exam: {e.examDate}
                      </div>
                    </div>
                    <span className="text-xs font-semibold text-emerald-600 group-hover:translate-x-0.5 transition-transform">
                      View →
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Matched Circulars */}
          {matchedNotices.length > 0 && (
            <div className="pt-3">
              <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2 flex items-center justify-between">
                <span>Circulars &amp; Notices ({matchedNotices.length})</span>
                <FileText className="w-3.5 h-3.5 text-slate-400" />
              </div>
              <div className="space-y-1.5">
                {matchedNotices.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => {
                      onClose();
                      onSelectNotice(n);
                    }}
                    className="w-full text-left p-2.5 rounded-xl hover:bg-slate-50 transition-colors flex items-center justify-between group border border-slate-100 hover:border-slate-200"
                  >
                    <div>
                      <div className="text-xs font-bold text-slate-900 group-hover:text-blue-700">
                        {n.title}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5 flex items-center gap-2">
                        <span className="font-mono font-semibold text-slate-600">{n.date}</span>
                        <span>·</span>
                        <span>{n.refNo}</span>
                      </div>
                    </div>
                    <ExternalLink className="w-4 h-4 text-slate-400 group-hover:text-slate-700" />
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Matched Centers */}
          {matchedCenters.length > 0 && (
            <div className="pt-3">
              <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2 flex items-center justify-between">
                <span>Accredited Centers ({matchedCenters.length})</span>
                <Building2 className="w-3.5 h-3.5 text-slate-400" />
              </div>
              <div className="space-y-1.5">
                {matchedCenters.map((c) => (
                  <div
                    key={c.id}
                    className="p-2.5 rounded-xl border border-slate-100 bg-slate-50 text-xs"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-slate-900">{c.name}</span>
                      <span className="font-mono text-purple-700 font-semibold">{c.code}</span>
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      {c.city}, {c.state} · Capacity: {c.capacity} nodes
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {totalResults === 0 && (
            <div className="py-8 text-center text-slate-500 text-xs">
              No matching records found for "{query}". Try searching by exam code like NEE, CMET or city name.
            </div>
          )}
        </div>

        {/* Footer info */}
        <div className="px-4 py-2.5 bg-slate-100 border-t border-slate-200 text-[11px] text-slate-500 flex items-center justify-between">
          <span>Search index updated live from NEA Server</span>
          <kbd className="font-mono bg-white px-1.5 py-0.5 rounded border border-slate-300 text-slate-600 font-semibold">
            ESC to close
          </kbd>
        </div>
      </div>
    </div>
  );
};
