/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo } from 'react';
import {
  HelpCircle,
  Search,
  ChevronDown,
  CheckCircle2,
  ExternalLink,
  MessageSquare,
  ThumbsUp,
  RotateCcw,
  BookOpen,
  Monitor,
  FileText,
  MapPin,
  Award,
  Sparkles,
} from 'lucide-react';
import { FAQItem, FAQ_ITEMS, filterFaqsByCategory, searchFaqs } from '../data/faqData';

interface FAQAccordionProps {
  onOpenAdmitCard?: () => void;
  onOpenMockExam?: () => void;
  onOpenExamApply?: () => void;
  onOpenCenterLocator?: () => void;
  onOpenFeedback?: () => void;
}

const CATEGORIES = [
  { id: 'all', label: 'All Queries', icon: BookOpen },
  { id: 'admit-card', label: 'Admit Card', icon: FileText },
  { id: 'cbt-exam', label: 'CBT Terminal', icon: Monitor },
  { id: 'scoring', label: 'Marking & Results', icon: Award },
  { id: 'centers', label: 'Test Centers', icon: MapPin },
  { id: 'registration', label: 'Registration', icon: HelpCircle },
];

export function FAQAccordion({
  onOpenAdmitCard,
  onOpenMockExam,
  onOpenExamApply,
  onOpenCenterLocator,
  onOpenFeedback,
}: FAQAccordionProps) {
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set(['faq-01']));
  const [helpfulFeedback, setHelpfulFeedback] = useState<Record<string, boolean>>({});

  // Filter & Search computation
  const filteredItems = useMemo(() => {
    let result = filterFaqsByCategory(FAQ_ITEMS, selectedCategory);
    if (searchQuery.trim()) {
      result = searchFaqs(result, searchQuery);
    }
    return result;
  }, [selectedCategory, searchQuery]);

  const toggleItem = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleExpandAll = () => {
    setExpandedIds(new Set(filteredItems.map((item) => item.id)));
  };

  const handleCollapseAll = () => {
    setExpandedIds(new Set());
  };

  const handleActionClick = (actionId?: 'admit-card' | 'cbt-mock' | 'apply' | 'grievance' | 'centers') => {
    if (!actionId) return;
    switch (actionId) {
      case 'admit-card':
        onOpenAdmitCard?.();
        break;
      case 'cbt-mock':
        onOpenMockExam?.();
        break;
      case 'apply':
        onOpenExamApply?.();
        break;
      case 'centers':
        onOpenCenterLocator?.();
        break;
      case 'grievance':
        onOpenFeedback?.();
        break;
      default:
        break;
    }
  };

  const handleRateHelpful = (id: string, isHelpful: boolean) => {
    setHelpfulFeedback((prev) => ({
      ...prev,
      [id]: isHelpful,
    }));
  };

  return (
    <section className="bg-slate-50 border-t border-slate-200 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-[1440px] mx-auto">
        {/* Section Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-8">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-semibold uppercase tracking-wider mb-2">
              <Sparkles className="w-3.5 h-3.5 text-emerald-600" />
              <span>Candidate Helpdesk & Guidelines</span>
            </div>
            <h2 className="text-2xl sm:text-3xl font-extrabold text-[#0B254E] tracking-tight">
              Frequently Asked Questions
            </h2>
            <p className="text-slate-600 text-sm sm:text-base mt-1 max-w-2xl">
              Official answers for examination guidelines, admit card downloads, CBT terminal procedures,
              and negative marking policies.
            </p>
          </div>

          {/* Quick expand/collapse controls */}
          <div className="flex items-center gap-2">
            <button
              onClick={handleExpandAll}
              className="text-xs font-medium text-slate-700 bg-white hover:bg-slate-100 border border-slate-300 px-3 py-1.5 rounded-md shadow-xs transition-colors"
            >
              Expand All
            </button>
            <button
              onClick={handleCollapseAll}
              className="text-xs font-medium text-slate-700 bg-white hover:bg-slate-100 border border-slate-300 px-3 py-1.5 rounded-md shadow-xs transition-colors"
            >
              Collapse All
            </button>
          </div>
        </div>

        {/* Search & Filter Toolbar */}
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs mb-6 space-y-4">
          <div className="flex flex-col md:flex-row gap-3 items-stretch md:items-center justify-between">
            {/* Search Input */}
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Search FAQs by topic (e.g., calculator, negative marking, freeze, ID proof)..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-10 py-2.5 bg-slate-50 border border-slate-300 rounded-lg text-sm text-slate-800 placeholder-slate-400 focus:outline-hidden focus:ring-2 focus:ring-emerald-500 focus:bg-white transition-all"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  aria-label="Clear search query"
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-1 rounded-md"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Match Counter */}
            <div className="text-xs text-slate-500 font-medium px-2 py-1 shrink-0">
              Showing <strong>{filteredItems.length}</strong> of <strong>{FAQ_ITEMS.length}</strong> questions
            </div>
          </div>

          {/* Category Pills */}
          <div className="flex items-center gap-2 overflow-x-auto pb-1 pt-1 scrollbar-thin">
            {CATEGORIES.map((cat) => {
              const Icon = cat.icon;
              const isActive = selectedCategory === cat.id;
              return (
                <button
                  key={cat.id}
                  onClick={() => setSelectedCategory(cat.id)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-all ${
                    isActive
                      ? 'bg-[#0B254E] text-white shadow-xs'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-800'
                  }`}
                >
                  <Icon className={`w-3.5 h-3.5 ${isActive ? 'text-emerald-400' : 'text-slate-500'}`} />
                  <span>{cat.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Accordion Items List */}
        {filteredItems.length === 0 ? (
          <div className="bg-white rounded-xl border border-slate-200 p-10 text-center shadow-xs">
            <HelpCircle className="w-12 h-12 text-slate-300 mx-auto mb-3" />
            <h3 className="text-base font-bold text-slate-800">No matching questions found</h3>
            <p className="text-sm text-slate-500 mt-1 max-w-md mx-auto">
              We couldn't find any questions matching &ldquo;{searchQuery}&rdquo;. Try using different keywords or ask our
              candidate support team directly.
            </p>
            <div className="mt-4 flex items-center justify-center gap-3">
              <button
                onClick={() => {
                  setSearchQuery('');
                  setSelectedCategory('all');
                }}
                className="px-4 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
              >
                Reset Search Filters
              </button>
              <button
                onClick={onOpenFeedback}
                className="px-4 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg shadow-xs transition-colors"
              >
                Ask Helpdesk
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredItems.map((item) => {
              const isExpanded = expandedIds.has(item.id);
              const rated = helpfulFeedback[item.id];

              return (
                <div
                  key={item.id}
                  className={`bg-white rounded-xl border transition-all duration-200 overflow-hidden shadow-xs ${
                    isExpanded ? 'border-emerald-500/60 ring-1 ring-emerald-500/20' : 'border-slate-200 hover:border-slate-300'
                  }`}
                >
                  {/* Header Button */}
                  <button
                    type="button"
                    onClick={() => toggleItem(item.id)}
                    aria-expanded={isExpanded}
                    className="w-full text-left p-4 sm:p-5 flex items-start sm:items-center justify-between gap-4 focus:outline-hidden focus-visible:bg-slate-50 transition-colors"
                  >
                    <div className="flex-1 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
                      <span className="inline-flex self-start sm:self-center px-2 py-0.5 rounded text-[11px] font-bold tracking-wide uppercase bg-sky-50 text-sky-800 border border-sky-200 shrink-0">
                        {item.categoryLabel}
                      </span>
                      <h3 className="text-base font-semibold text-[#0B254E] hover:text-emerald-700 transition-colors">
                        {item.question}
                      </h3>
                    </div>

                    <div
                      className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 transition-transform duration-200 ${
                        isExpanded ? 'bg-emerald-100 text-emerald-800 rotate-180' : 'bg-slate-100 text-slate-500'
                      }`}
                    >
                      <ChevronDown className="w-4 h-4" />
                    </div>
                  </button>

                  {/* Accordion Body */}
                  {isExpanded && (
                    <div className="px-4 sm:px-6 pb-5 pt-1 border-t border-slate-100 text-slate-700 text-sm leading-relaxed animate-in fade-in-50 duration-150">
                      <p className="mt-2 text-slate-800 font-normal">{item.answer}</p>

                      {/* Bulleted Key Points */}
                      {item.keyPoints && item.keyPoints.length > 0 && (
                        <div className="mt-3.5 bg-slate-50 rounded-lg p-3.5 border border-slate-200/80">
                          <h4 className="text-xs font-bold uppercase tracking-wider text-slate-600 mb-2">
                            Key Official Guidelines:
                          </h4>
                          <ul className="space-y-1.5">
                            {item.keyPoints.map((point, index) => (
                              <li key={index} className="flex items-start gap-2 text-xs sm:text-sm text-slate-700">
                                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                                <span>{point}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Action & Feedback row */}
                      <div className="mt-4 pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3">
                        {item.actionLink ? (
                          <button
                            type="button"
                            onClick={() => handleActionClick(item.actionLink!.actionId)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold rounded-md shadow-xs transition-colors"
                          >
                            <span>{item.actionLink.label}</span>
                            <ExternalLink className="w-3.5 h-3.5" />
                          </button>
                        ) : (
                          <div />
                        )}

                        {/* Was this helpful micro-interaction */}
                        <div className="flex items-center gap-2 text-xs text-slate-500">
                          {rated !== undefined ? (
                            <span className="text-emerald-700 font-medium inline-flex items-center gap-1">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              Thank you for your feedback!
                            </span>
                          ) : (
                            <>
                              <span>Was this answer helpful?</span>
                              <button
                                onClick={() => handleRateHelpful(item.id, true)}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-slate-200 hover:bg-slate-100 text-slate-700 text-[11px] transition-colors"
                                title="Yes, helpful"
                              >
                                <ThumbsUp className="w-3 h-3 text-slate-600" />
                                <span>Yes</span>
                              </button>
                              <button
                                onClick={() => handleRateHelpful(item.id, false)}
                                className="px-2 py-0.5 rounded border border-slate-200 hover:bg-slate-100 text-slate-700 text-[11px] transition-colors"
                                title="No, need more details"
                              >
                                <span>No</span>
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Helpdesk Support Banner beneath FAQ */}
        <div className="mt-8 bg-gradient-to-r from-[#0B254E] to-[#103a75] text-white rounded-xl p-5 sm:p-6 shadow-md flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-white/10 flex items-center justify-center shrink-0 border border-white/20">
              <MessageSquare className="w-6 h-6 text-emerald-400" />
            </div>
            <div>
              <h3 className="text-base sm:text-lg font-bold">Have a specific examination query or technical issue?</h3>
              <p className="text-xs sm:text-sm text-slate-200 mt-0.5">
                Our examination support desk operates 24/7 during active test windows.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 w-full md:w-auto">
            <button
              onClick={onOpenFeedback}
              className="flex-1 md:flex-initial inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-500 hover:bg-emerald-600 text-slate-900 font-bold text-xs rounded-lg transition-colors shadow-sm"
            >
              <MessageSquare className="w-4 h-4 text-slate-900" />
              <span>Report Issue / Give Feedback</span>
            </button>
            <a
              href="tel:+911800100200"
              className="flex-1 md:flex-initial inline-flex items-center justify-center gap-1.5 px-4 py-2.5 bg-white/10 hover:bg-white/20 text-white font-medium text-xs rounded-lg border border-white/20 transition-colors"
            >
              <span>Call Helpline</span>
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
