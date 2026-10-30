/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { X, FileText, Download, Printer, Calendar, ShieldCheck, CheckCircle2 } from 'lucide-react';
import { NoticeItem } from '../data/portalData';

interface NoticeDetailModalProps {
  notice: NoticeItem | null;
  onClose: () => void;
}

export const NoticeDetailModal: React.FC<NoticeDetailModalProps> = ({ notice, onClose }) => {
  if (!notice) return null;

  const handleDownload = () => {
    // Generate simulated PDF text blob download
    const element = document.createElement('a');
    const file = new Blob([`${notice.title}\nRef: ${notice.refNo}\nDate: ${notice.date}\n\n${notice.fullContent}`], {
      type: 'text/plain',
    });
    element.href = URL.createObjectURL(file);
    element.download = `${notice.refNo.replace(/[^a-zA-Z0-9]/g, '_')}_Circular.txt`;
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/75 backdrop-blur-xs flex items-center justify-center p-3 sm:p-6 animate-in fade-in duration-150">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-2xl overflow-hidden my-6 flex flex-col">
        {/* Navy Header */}
        <div className="bg-[#0F172A] text-white px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-500/20 text-sky-400 rounded-lg">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-sky-400">
                Official Gazette Notification
              </span>
              <h2 className="text-sm font-bold truncate max-w-md">
                {notice.refNo}
              </h2>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            aria-label="Close notice modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto text-slate-800">
          <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-100 text-xs">
            <div className="flex items-center gap-2">
              <span className="font-mono bg-slate-100 text-slate-700 px-2 py-0.5 rounded font-bold">
                {notice.date}
              </span>
              <span className="bg-blue-100 text-blue-800 px-2 py-0.5 rounded font-semibold">
                {notice.category}
              </span>
              {notice.isNew && (
                <span className="bg-rose-600 text-white px-1.5 py-0.2 rounded font-extrabold uppercase text-[10px]">
                  New
                </span>
              )}
            </div>
            <span className="text-slate-400 text-[11px] font-mono">{notice.fileSize}</span>
          </div>

          <h3 className="text-base font-extrabold text-slate-900 leading-snug">
            {notice.title}
          </h3>

          <div className="bg-slate-50 border border-slate-200 p-4 rounded-xl text-xs sm:text-sm text-slate-700 whitespace-pre-line leading-relaxed font-sans">
            {notice.fullContent}
          </div>

          <div className="p-3 bg-emerald-50 rounded-xl border border-emerald-200 text-emerald-900 text-xs flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>Authenticated document digitally stamped by Central Assessment Directorate.</span>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="p-4 bg-slate-50 border-t border-slate-200 flex items-center justify-between text-xs">
          <button
            onClick={() => window.print()}
            className="px-3.5 py-2 bg-white hover:bg-slate-100 text-slate-700 border border-slate-300 rounded-lg font-semibold flex items-center gap-1.5 transition-colors"
          >
            <Printer className="w-4 h-4" />
            <span>Print Notice</span>
          </button>

          <button
            onClick={handleDownload}
            className="px-4 py-2 bg-blue-900 hover:bg-blue-800 text-white rounded-lg font-bold flex items-center gap-1.5 transition-colors shadow-2xs"
          >
            <Download className="w-4 h-4" />
            <span>Download Official Bulletin</span>
          </button>
        </div>
      </div>
    </div>
  );
};
