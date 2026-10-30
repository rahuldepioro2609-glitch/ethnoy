/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  Bell,
  Calendar,
  Link2,
  FileText,
  User,
  IdCard,
  ClipboardCheck,
  BarChart2,
  Building2,
} from 'lucide-react';
import {
  EXAMINATIONS,
  NOTICES,
  QUICK_LINKS_TILES,
  ExamItem,
  NoticeItem,
} from '../data/portalData';

interface ThreeColumnDataGridProps {
  onOpenNotice: (notice: NoticeItem) => void;
  onOpenExamApply: (exam: ExamItem) => void;
  onQuickLinkAction: (actionId: string) => void;
  filterExamId?: string;
}

export const ThreeColumnDataGrid: React.FC<ThreeColumnDataGridProps> = ({
  onOpenNotice,
  onOpenExamApply,
  onQuickLinkAction,
  filterExamId,
}) => {
  const displayedExams = filterExamId
    ? EXAMINATIONS.filter((e) => e.id === filterExamId)
    : EXAMINATIONS;

  const renderQuickTileIcon = (type: string) => {
    switch (type) {
      case 'registration':
        return <FileText className="w-5 h-5 text-emerald-600" />;
      case 'student-login':
        return <User className="w-5 h-5 text-blue-600" />;
      case 'admit-card':
        return <IdCard className="w-5 h-5 text-purple-600" />;
      case 'answer-key':
        return <ClipboardCheck className="w-5 h-5 text-rose-500" />;
      case 'result':
        return <BarChart2 className="w-5 h-5 text-amber-500" />;
      case 'institute-login':
        return <Building2 className="w-5 h-5 text-teal-600" />;
      default:
        return <FileText className="w-5 h-5 text-slate-600" />;
    }
  };

  return (
    <section className="py-8 bg-[#F4F8FC]" aria-label="ELTNOY Information Center">
      <div className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
          {/* COLUMN 1: Latest Notifications (approx 4 cols) */}
          <div className="lg:col-span-4 bg-white rounded-xl shadow-xs border border-slate-200/90 overflow-hidden flex flex-col">
            {/* Deep Navy Blue Header Bar */}
            <div className="bg-[#0B254E] text-white px-5 py-3.5 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <Bell className="w-4 h-4 text-sky-400" />
                <h3 className="text-sm font-bold tracking-tight">
                  Latest Notifications
                </h3>
              </div>
              <button
                onClick={() => onOpenNotice(NOTICES[0])}
                className="text-xs text-sky-200 hover:text-white transition-colors"
              >
                View All →
              </button>
            </div>

            {/* Notifications Rows */}
            <div className="divide-y divide-slate-100 flex-1">
              {NOTICES.map((notice) => (
                <div
                  key={notice.id}
                  onClick={() => onOpenNotice(notice)}
                  className="p-3.5 sm:p-4 hover:bg-slate-50/90 transition-colors cursor-pointer flex items-center gap-3.5 group"
                >
                  {/* Date Badge: Stacked Blue Block */}
                  <div className="w-11 h-11 rounded-lg bg-sky-50 border border-sky-100 text-[#0284C7] flex flex-col items-center justify-center shrink-0">
                    <span className="text-sm font-black leading-none">{notice.day}</span>
                    <span className="text-[10px] font-bold uppercase tracking-wider">{notice.month}</span>
                  </div>

                  {/* Title & Badge */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-xs font-semibold text-slate-800 group-hover:text-[#0284C7] transition-colors leading-snug line-clamp-2">
                        {notice.title}
                      </p>
                      {notice.isNew && (
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-[#EF4444] text-white uppercase shrink-0">
                          New
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* COLUMN 2: Upcoming Examinations (5 cols) */}
          <div className="lg:col-span-5 bg-white rounded-xl shadow-xs border border-slate-200/90 overflow-hidden flex flex-col">
            {/* Rich Green Header Bar */}
            <div className="bg-[#16A34A] text-white px-5 py-3.5 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <Calendar className="w-4 h-4 text-emerald-100" />
                <h3 className="text-sm font-bold tracking-tight">
                  Upcoming Examinations
                </h3>
              </div>
              <button
                onClick={() => onOpenExamApply(EXAMINATIONS[0])}
                className="text-xs text-emerald-100 hover:text-white transition-colors"
              >
                View All →
              </button>
            </div>

            {/* Examinations Cards */}
            <div className="divide-y divide-slate-100 flex-1">
              {displayedExams.map((exam) => (
                <div
                  key={exam.id}
                  className="p-3.5 sm:p-4 hover:bg-slate-50/80 transition-colors flex items-center justify-between gap-3"
                >
                  {/* Left: Date block + Exam info */}
                  <div className="flex items-center gap-3 min-w-0">
                    {/* Date Block */}
                    <div className="w-11 h-11 rounded-lg bg-teal-50 border border-teal-100 text-teal-700 flex flex-col items-center justify-center shrink-0">
                      <span className="text-sm font-black leading-none">{exam.day}</span>
                      <span className="text-[10px] font-bold uppercase tracking-wider">{exam.month}</span>
                    </div>

                    {/* Title & Audience */}
                    <div className="min-w-0">
                      <h4 className="text-xs font-bold text-slate-900 leading-snug truncate">
                        {exam.name}
                      </h4>
                      <p className="text-[11px] text-slate-500 mt-0.5 truncate">
                        {exam.targetAudience}
                      </p>
                    </div>
                  </div>

                  {/* Right: Apply Button */}
                  <div className="shrink-0">
                    {exam.isButtonActive ? (
                      <button
                        onClick={() => onOpenExamApply(exam)}
                        className="px-3.5 py-1.5 bg-[#16A34A] hover:bg-[#15803D] text-white text-xs font-bold rounded-md shadow-2xs transition-colors whitespace-nowrap"
                      >
                        Apply Now
                      </button>
                    ) : (
                      <button
                        onClick={() => onOpenExamApply(exam)}
                        className="px-3.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs font-semibold rounded-md border border-slate-200 transition-colors whitespace-nowrap"
                      >
                        Apply Soon
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* COLUMN 3: Quick Links (3 cols) */}
          <div className="lg:col-span-3 bg-white rounded-xl shadow-xs border border-slate-200/90 overflow-hidden flex flex-col">
            {/* Vibrant Cyan Header Bar */}
            <div className="bg-[#0284C7] text-white px-5 py-3.5 flex items-center gap-2.5">
              <Link2 className="w-4 h-4 text-sky-100" />
              <h3 className="text-sm font-bold tracking-tight">
                Quick Links
              </h3>
            </div>

            {/* 3x2 Grid of Colorful Tiles */}
            <div className="p-4 grid grid-cols-2 gap-3 flex-1">
              {QUICK_LINKS_TILES.map((tile) => (
                <button
                  key={tile.id}
                  onClick={() => onQuickLinkAction(tile.actionId)}
                  className={`p-3 rounded-xl border ${tile.borderColor} ${tile.bgColor} hover:shadow-xs transition-all flex flex-col items-center justify-center text-center gap-2 group hover:-translate-y-0.5`}
                >
                  <div className={`p-2 rounded-lg ${tile.iconBg} group-hover:scale-105 transition-transform`}>
                    {renderQuickTileIcon(tile.iconType)}
                  </div>
                  <span className="text-xs font-bold text-slate-800 leading-tight">
                    {tile.title}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
