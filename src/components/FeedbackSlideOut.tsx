/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import {
  MessageSquarePlus,
  X,
  Send,
  AlertCircle,
  CheckCircle2,
  Bug,
  Lightbulb,
  Monitor,
  IdCard,
  Zap,
  HelpCircle,
  Star,
  Paperclip,
  Clock,
  Search,
  Filter,
  Copy,
  Check,
  ChevronRight,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import {
  FeedbackEntry,
  FeedbackType,
  FeedbackPriority,
  getStoredFeedbackEntries,
  saveFeedbackEntries,
  validateFeedback,
  createFeedbackTicket,
  filterFeedbackEntries,
} from '../utils/feedbackLogic';

interface FeedbackSlideOutProps {
  isOpen: boolean;
  onClose: () => void;
  onOpen: () => void;
  loggedInUser?: { name: string; role: string; id: string } | null;
}

export const FeedbackSlideOut: React.FC<FeedbackSlideOutProps> = ({
  isOpen,
  onClose,
  onOpen,
  loggedInUser,
}) => {
  const [activeTab, setActiveTab] = useState<'submit' | 'history'>('submit');
  const [entries, setEntries] = useState<FeedbackEntry[]>([]);

  // Form state
  const [type, setType] = useState<FeedbackType>('bug');
  const [module, setModule] = useState<string>('Online CBT Exam Simulator');
  const [priority, setPriority] = useState<FeedbackPriority>('medium');
  const [rating, setRating] = useState<number>(4);
  const [hoverRating, setHoverRating] = useState<number>(0);
  const [title, setTitle] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [candidateName, setCandidateName] = useState<string>('');
  const [email, setEmail] = useState<string>('');
  const [applicationNumber, setApplicationNumber] = useState<string>('');
  const [attachmentName, setAttachmentName] = useState<string>('');

  // UI state
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [submittedTicket, setSubmittedTicket] = useState<FeedbackEntry | null>(null);
  const [copiedId, setCopiedId] = useState<boolean>(false);

  // History filtering
  const [historySearch, setHistorySearch] = useState<string>('');
  const [historyFilterType, setHistoryFilterType] = useState<string>('all');
  const [historyFilterStatus, setHistoryFilterStatus] = useState<string>('all');

  // Load stored entries on mount
  useEffect(() => {
    const loaded = getStoredFeedbackEntries();
    setEntries(loaded);
  }, []);

  // Autofill if logged in
  useEffect(() => {
    if (loggedInUser) {
      setCandidateName(loggedInUser.name);
      if (loggedInUser.id) {
        setApplicationNumber(loggedInUser.id);
      }
    }
  }, [loggedInUser]);

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const validation = validateFeedback({
      title,
      description,
      type,
      email,
    });

    if (!validation.isValid) {
      setErrors(validation.errors);
      return;
    }

    setErrors({});
    setIsSubmitting(true);

    // Simulate network delay for realistic feedback submission
    setTimeout(() => {
      const newTicket = createFeedbackTicket({
        type,
        title: title.trim(),
        description: description.trim(),
        module,
        candidateName: candidateName.trim() || (loggedInUser?.name || 'Aspirant Student'),
        email: email.trim() || undefined,
        applicationNumber: applicationNumber.trim() || undefined,
        priority,
        rating,
        attachmentName: attachmentName || undefined,
      });

      const updatedEntries = [newTicket, ...entries];
      setEntries(updatedEntries);
      saveFeedbackEntries(updatedEntries);

      setIsSubmitting(false);
      setSubmittedTicket(newTicket);

      // Reset form
      setTitle('');
      setDescription('');
      setAttachmentName('');
    }, 450);
  };

  const handleCopyTicketId = (id: string) => {
    navigator.clipboard.writeText(id);
    setCopiedId(true);
    setTimeout(() => setCopiedId(false), 2000);
  };

  const handleMockFileUpload = () => {
    const sampleFiles = [
      'cbt_calculator_error.png',
      'admit_card_preview_glitch.pdf',
      'portal_latency_log.txt',
      'suggestion_mockup.jpeg',
    ];
    const picked = sampleFiles[Math.floor(Math.random() * sampleFiles.length)];
    setAttachmentName(picked);
  };

  const filteredHistory = filterFeedbackEntries(entries, {
    type: historyFilterType,
    status: historyFilterStatus,
    query: historySearch,
  });

  const getTypeBadge = (itemType: FeedbackType) => {
    switch (itemType) {
      case 'bug':
        return { label: 'Bug Report', color: 'bg-rose-50 text-rose-700 border-rose-200', icon: Bug };
      case 'suggestion':
        return { label: 'Suggestion', color: 'bg-emerald-50 text-emerald-700 border-emerald-200', icon: Lightbulb };
      case 'cbt_issue':
        return { label: 'CBT Issue', color: 'bg-amber-50 text-amber-700 border-amber-200', icon: Monitor };
      case 'admit_card':
        return { label: 'Admit Card', color: 'bg-purple-50 text-purple-700 border-purple-200', icon: IdCard };
      case 'performance':
        return { label: 'Speed & UI', color: 'bg-sky-50 text-sky-700 border-sky-200', icon: Zap };
      default:
        return { label: 'Other', color: 'bg-slate-50 text-slate-700 border-slate-200', icon: HelpCircle };
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'resolved':
        return { label: 'Resolved', color: 'bg-emerald-100 text-emerald-800 border-emerald-300' };
      case 'in_progress':
        return { label: 'In Progress', color: 'bg-sky-100 text-sky-800 border-sky-300' };
      default:
        return { label: 'Under Review', color: 'bg-amber-100 text-amber-800 border-amber-300' };
    }
  };

  return (
    <>
      {/* Persistent Floating Tab Trigger on Right Viewport Edge */}
      <button
        onClick={onOpen}
        className="fixed right-0 top-1/2 -translate-y-1/2 z-40 bg-[#0B254E] hover:bg-[#16A34A] text-white py-3 px-2 rounded-l-xl shadow-xl border-l border-t border-b border-white/20 transition-all duration-300 flex flex-col items-center gap-2 group cursor-pointer focus:outline-hidden focus:ring-2 focus:ring-emerald-400"
        aria-label="Open portal feedback and bug report panel"
        aria-expanded={isOpen}
      >
        <MessageSquarePlus className="w-4 h-4 text-emerald-400 group-hover:scale-110 transition-transform" />
        <span className="text-[11px] font-bold tracking-wider uppercase [writing-mode:vertical-rl] rotate-180 select-none">
          Feedback
        </span>
        <span className="w-5 h-5 rounded-full bg-[#16A34A] group-hover:bg-[#0B254E] text-white text-[10px] font-black flex items-center justify-center shadow-xs">
          {entries.length}
        </span>
      </button>

      {/* Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs z-50 transition-opacity"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      {/* Slide-out Drawer */}
      <div
        className={`fixed inset-y-0 right-0 z-50 w-full sm:max-w-md md:max-w-lg bg-white shadow-2xl flex flex-col border-l border-slate-200 transform transition-transform duration-300 ease-out ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-drawer-title"
      >
        {/* Header */}
        <div className="bg-[#0B254E] text-white px-5 py-4 border-b border-slate-800 shrink-0">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-sky-500/20 text-sky-300 text-[11px] font-semibold mb-1 border border-sky-400/30">
                <Sparkles className="w-3 h-3 text-sky-400" />
                <span>Candidate Support Hub</span>
              </div>
              <h2 id="feedback-drawer-title" className="text-lg font-bold text-white flex items-center gap-2">
                <span>Portal Feedback &amp; Bug Report</span>
              </h2>
              <p className="text-xs text-sky-200/90 mt-0.5">
                Report an examination issue or suggest improvements to ELTNOY
              </p>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 text-slate-300 hover:text-white hover:bg-white/10 rounded-lg transition-colors cursor-pointer"
              aria-label="Close feedback panel"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Navigation Tabs */}
          <div className="flex items-center gap-2 mt-4 pt-3 border-t border-slate-700/60">
            <button
              onClick={() => {
                setActiveTab('submit');
                setSubmittedTicket(null);
              }}
              className={`flex-1 py-1.5 px-3 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1.5 ${
                activeTab === 'submit'
                  ? 'bg-[#16A34A] text-white shadow-xs'
                  : 'bg-white/10 text-slate-200 hover:bg-white/20'
              }`}
            >
              <MessageSquarePlus className="w-3.5 h-3.5" />
              <span>Submit Feedback</span>
            </button>

            <button
              onClick={() => setActiveTab('history')}
              className={`flex-1 py-1.5 px-3 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1.5 ${
                activeTab === 'history'
                  ? 'bg-[#16A34A] text-white shadow-xs'
                  : 'bg-white/10 text-slate-200 hover:bg-white/20'
              }`}
            >
              <Clock className="w-3.5 h-3.5" />
              <span>Recent Submissions ({entries.length})</span>
            </button>
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-5 bg-slate-50/60">
          {activeTab === 'submit' ? (
            submittedTicket ? (
              /* Success State */
              <div className="bg-white p-6 rounded-2xl border border-emerald-200 shadow-sm text-center space-y-4 animate-in fade-in zoom-in-95">
                <div className="w-14 h-14 bg-emerald-100 text-[#16A34A] rounded-full mx-auto flex items-center justify-center shadow-xs">
                  <CheckCircle2 className="w-8 h-8" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-900">
                    Feedback Ticket Generated!
                  </h3>
                  <p className="text-xs text-slate-600 mt-1 max-w-sm mx-auto">
                    Thank you for helping us make the ELTNOY portal more secure and reliable. Your report has been dispatched to our technical assessment directorate.
                  </p>
                </div>

                {/* Ticket ID Box */}
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3.5 flex items-center justify-between max-w-xs mx-auto">
                  <div className="text-left">
                    <span className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">
                      Reference Ticket ID
                    </span>
                    <div className="text-sm font-black text-[#0B254E] tracking-tight">
                      {submittedTicket.id}
                    </div>
                  </div>
                  <button
                    onClick={() => handleCopyTicketId(submittedTicket.id)}
                    className="p-2 rounded-lg bg-white border border-slate-200 hover:bg-slate-100 text-slate-700 text-xs font-semibold flex items-center gap-1 transition-colors"
                  >
                    {copiedId ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-600" />
                        <span className="text-emerald-700">Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>Copy</span>
                      </>
                    )}
                  </button>
                </div>

                <div className="text-left text-xs bg-sky-50 border border-sky-100 rounded-lg p-3 text-sky-900 space-y-1">
                  <div className="font-semibold flex items-center gap-1.5 text-sky-800">
                    <ShieldCheck className="w-4 h-4 text-[#0284C7]" />
                    <span>Resolution Workflow</span>
                  </div>
                  <p className="text-[11px] leading-relaxed text-sky-700">
                    Priority: <strong>{submittedTicket.priority.toUpperCase()}</strong> · Module: {submittedTicket.module}
                  </p>
                  <p className="text-[11px] leading-relaxed text-sky-700">
                    Average resolution time for candidates: <strong>2 - 6 hours</strong>.
                  </p>
                </div>

                <div className="flex gap-2 pt-2">
                  <button
                    onClick={() => setActiveTab('history')}
                    className="flex-1 py-2 px-3 bg-[#0B254E] hover:bg-[#091e3e] text-white text-xs font-bold rounded-lg transition-colors flex items-center justify-center gap-1.5"
                  >
                    <span>View in History</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => setSubmittedTicket(null)}
                    className="py-2 px-3 border border-slate-200 hover:bg-slate-100 text-slate-700 text-xs font-semibold rounded-lg transition-colors"
                  >
                    Submit Another
                  </button>
                </div>
              </div>
            ) : (
              /* Feedback Submission Form */
              <form onSubmit={handleSubmit} className="space-y-4">
                {/* Category Selector */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">
                    Feedback Category <span className="text-rose-500">*</span>
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { id: 'bug', label: 'Bug Report', icon: Bug, color: 'hover:border-rose-300' },
                      { id: 'suggestion', label: 'Suggestion', icon: Lightbulb, color: 'hover:border-emerald-300' },
                      { id: 'cbt_issue', label: 'CBT Exam Issue', icon: Monitor, color: 'hover:border-amber-300' },
                      { id: 'admit_card', label: 'Admit Card', icon: IdCard, color: 'hover:border-purple-300' },
                      { id: 'performance', label: 'Speed & UI', icon: Zap, color: 'hover:border-sky-300' },
                      { id: 'other', label: 'General Query', icon: HelpCircle, color: 'hover:border-slate-300' },
                    ].map((item) => {
                      const Icon = item.icon;
                      const isSelected = type === item.id;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => setType(item.id as FeedbackType)}
                          className={`p-2.5 rounded-xl border text-left transition-all flex flex-col items-center justify-center text-center gap-1 cursor-pointer ${
                            isSelected
                              ? 'bg-[#0B254E] text-white border-[#0B254E] shadow-2xs'
                              : `bg-white text-slate-700 border-slate-200 ${item.color} hover:bg-slate-50`
                          }`}
                        >
                          <Icon className={`w-4 h-4 ${isSelected ? 'text-sky-300' : 'text-slate-500'}`} />
                          <span className="text-[11px] font-semibold leading-tight">
                            {item.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Target Module Dropdown */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Portal Area / Module
                  </label>
                  <select
                    value={module}
                    onChange={(e) => setModule(e.target.value)}
                    className="w-full text-xs bg-white border border-slate-300 rounded-lg p-2.5 text-slate-800 focus:outline-hidden focus:ring-2 focus:ring-[#16A34A] focus:border-transparent"
                  >
                    <option value="Online CBT Exam Simulator">Online CBT Exam Simulator</option>
                    <option value="Admit Card Download">Admit Card Download</option>
                    <option value="Online Application Portal">Online Application Portal</option>
                    <option value="Knowledge Base & Center Locator">Knowledge Base &amp; Center Locator</option>
                    <option value="Result & Answer Key Verification">Result &amp; Answer Key Verification</option>
                    <option value="Portal Navigation & General Speed">Portal Navigation &amp; General Speed</option>
                  </select>
                </div>

                {/* Severity Priority & Rating */}
                <div className="grid grid-cols-2 gap-3 bg-white p-3 rounded-xl border border-slate-200">
                  <div>
                    <label className="block text-[11px] font-bold text-slate-700 mb-1">
                      Urgency Level
                    </label>
                    <select
                      value={priority}
                      onChange={(e) => setPriority(e.target.value as FeedbackPriority)}
                      className="w-full text-xs bg-slate-50 border border-slate-200 rounded-lg p-1.5 font-medium text-slate-800"
                    >
                      <option value="low">Low (General)</option>
                      <option value="medium">Medium (Standard)</option>
                      <option value="high">High (Affects Exam)</option>
                      <option value="critical">Critical (Blocking)</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] font-bold text-slate-700 mb-1">
                      Portal Rating
                    </label>
                    <div className="flex items-center gap-1 pt-0.5">
                      {[1, 2, 3, 4, 5].map((star) => (
                        <button
                          key={star}
                          type="button"
                          onMouseEnter={() => setHoverRating(star)}
                          onMouseLeave={() => setHoverRating(0)}
                          onClick={() => setRating(star)}
                          className="p-0.5 text-amber-400 hover:scale-110 transition-transform"
                          aria-label={`Rate ${star} star`}
                        >
                          <Star
                            className={`w-4 h-4 ${
                              (hoverRating || rating) >= star ? 'fill-amber-400 text-amber-400' : 'text-slate-300'
                            }`}
                          />
                        </button>
                      ))}
                      <span className="text-[10px] text-slate-500 font-bold ml-1">{rating}/5</span>
                    </div>
                  </div>
                </div>

                {/* Subject / Title */}
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Subject / Summary <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="e.g. Timer lagging during section switch in CBT mock"
                    className={`w-full text-xs bg-white border rounded-lg p-2.5 text-slate-800 focus:outline-hidden focus:ring-2 focus:ring-[#16A34A] ${
                      errors.title ? 'border-rose-400 bg-rose-50/30' : 'border-slate-300'
                    }`}
                  />
                  {errors.title && (
                    <p className="text-[11px] text-rose-500 mt-1 flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" />
                      <span>{errors.title}</span>
                    </p>
                  )}
                </div>

                {/* Description */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs font-bold text-slate-700">
                      Detailed Description <span className="text-rose-500">*</span>
                    </label>
                    <span className="text-[10px] text-slate-400">
                      {description.length}/1000
                    </span>
                  </div>
                  <textarea
                    rows={4}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Please explain what happened, steps to reproduce, or your suggested enhancement..."
                    className={`w-full text-xs bg-white border rounded-lg p-2.5 text-slate-800 focus:outline-hidden focus:ring-2 focus:ring-[#16A34A] ${
                      errors.description ? 'border-rose-400 bg-rose-50/30' : 'border-slate-300'
                    }`}
                  />
                  {errors.description && (
                    <p className="text-[11px] text-rose-500 mt-1 flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" />
                      <span>{errors.description}</span>
                    </p>
                  )}
                </div>

                {/* Candidate Information (Optional) */}
                <div className="bg-white p-3.5 rounded-xl border border-slate-200 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-800">
                      Candidate Details (Optional)
                    </span>
                    <span className="text-[10px] text-slate-400">For ticket resolution follow-up</span>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <input
                        type="text"
                        value={candidateName}
                        onChange={(e) => setCandidateName(e.target.value)}
                        placeholder="Full Name"
                        className="w-full text-xs bg-slate-50 border border-slate-200 rounded-lg p-2 text-slate-800"
                      />
                    </div>
                    <div>
                      <input
                        type="text"
                        value={applicationNumber}
                        onChange={(e) => setApplicationNumber(e.target.value)}
                        placeholder="App No. (e.g. NEA-2026)"
                        className="w-full text-xs bg-slate-50 border border-slate-200 rounded-lg p-2 text-slate-800"
                      />
                    </div>
                  </div>

                  <div>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="Email address for status updates"
                      className={`w-full text-xs bg-slate-50 border rounded-lg p-2 text-slate-800 ${
                        errors.email ? 'border-rose-400' : 'border-slate-200'
                      }`}
                    />
                    {errors.email && (
                      <p className="text-[11px] text-rose-500 mt-1">{errors.email}</p>
                    )}
                  </div>
                </div>

                {/* Mock Screenshot / File Attachment */}
                <div className="bg-white p-3 rounded-xl border border-slate-200 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <Paperclip className="w-4 h-4 text-slate-400 shrink-0" />
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-700 truncate">
                        {attachmentName ? attachmentName : 'Attach Screenshot or Error Log'}
                      </div>
                      <div className="text-[10px] text-slate-400">
                        PNG, JPG, PDF up to 5MB
                      </div>
                    </div>
                  </div>
                  {attachmentName ? (
                    <button
                      type="button"
                      onClick={() => setAttachmentName('')}
                      className="text-[11px] text-rose-600 hover:underline font-semibold"
                    >
                      Remove
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={handleMockFileUpload}
                      className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-md border border-slate-200 transition-colors shrink-0"
                    >
                      Attach File
                    </button>
                  )}
                </div>

                {/* Submit Action */}
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full py-3 bg-[#16A34A] hover:bg-[#15803D] active:bg-[#166534] disabled:opacity-70 text-white font-bold text-xs sm:text-sm rounded-xl shadow-sm flex items-center justify-center gap-2 transition-all cursor-pointer"
                >
                  {isSubmitting ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      <span>Generating Ticket...</span>
                    </>
                  ) : (
                    <>
                      <Send className="w-4 h-4" />
                      <span>Submit Feedback Ticket</span>
                    </>
                  )}
                </button>
              </form>
            )
          ) : (
            /* History / Previous Submissions Tab */
            <div className="space-y-3">
              {/* Filter and Search Bar */}
              <div className="space-y-2 bg-white p-3 rounded-xl border border-slate-200 shadow-2xs">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={historySearch}
                    onChange={(e) => setHistorySearch(e.target.value)}
                    placeholder="Search by ticket ID, keyword, module..."
                    className="w-full pl-8 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-800 focus:outline-hidden focus:ring-1 focus:ring-[#16A34A]"
                  />
                </div>

                <div className="flex items-center gap-1.5 flex-wrap">
                  <Filter className="w-3 h-3 text-slate-400 mr-0.5" />
                  {[
                    { id: 'all', label: 'All' },
                    { id: 'bug', label: 'Bugs' },
                    { id: 'suggestion', label: 'Ideas' },
                    { id: 'cbt_issue', label: 'CBT' },
                    { id: 'admit_card', label: 'Admit' },
                  ].map((filter) => (
                    <button
                      key={filter.id}
                      onClick={() => setHistoryFilterType(filter.id)}
                      className={`px-2 py-0.5 rounded text-[10px] font-bold transition-colors ${
                        historyFilterType === filter.id
                          ? 'bg-[#0B254E] text-white'
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      }`}
                    >
                      {filter.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Feedbacks List */}
              {filteredHistory.length === 0 ? (
                <div className="bg-white p-8 rounded-xl border border-slate-200 text-center space-y-2">
                  <div className="w-10 h-10 rounded-full bg-slate-100 text-slate-400 mx-auto flex items-center justify-center">
                    <Search className="w-5 h-5" />
                  </div>
                  <p className="text-xs font-bold text-slate-700">No matching feedback entries</p>
                  <p className="text-[11px] text-slate-500">
                    Try adjusting your search query or submit a new report.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {filteredHistory.map((item) => {
                    const typeBadge = getTypeBadge(item.type);
                    const statusBadge = getStatusBadge(item.status);
                    const TypeIcon = typeBadge.icon;
                    const dateFormatted = new Date(item.createdAt).toLocaleDateString('en-GB', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    });

                    return (
                      <div
                        key={item.id}
                        className="bg-white rounded-xl p-3.5 border border-slate-200 shadow-2xs hover:shadow-xs transition-shadow space-y-2.5"
                      >
                        {/* Header: ID + Status + Category */}
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-[11px] font-black text-[#0B254E] bg-slate-100 px-2 py-0.5 rounded border border-slate-200">
                              {item.id}
                            </span>
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold border ${typeBadge.color}`}>
                              <TypeIcon className="w-3 h-3" />
                              <span>{typeBadge.label}</span>
                            </span>
                          </div>

                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${statusBadge.color}`}>
                            {statusBadge.label}
                          </span>
                        </div>

                        {/* Title & Description */}
                        <div>
                          <h4 className="text-xs font-bold text-slate-900 leading-snug">
                            {item.title}
                          </h4>
                          <p className="text-[11px] text-slate-600 mt-1 leading-relaxed">
                            {item.description}
                          </p>
                        </div>

                        {/* Resolution Note if available */}
                        {item.resolutionNote && (
                          <div className="bg-emerald-50 border border-emerald-100 rounded-lg p-2 text-[11px] text-emerald-800">
                            <span className="font-bold">Directorate Update: </span>
                            {item.resolutionNote}
                          </div>
                        )}

                        {/* Footer metadata */}
                        <div className="flex items-center justify-between pt-2 border-t border-slate-100 text-[10px] text-slate-400">
                          <span className="truncate max-w-[200px]">
                            {item.module} · {item.candidateName || 'Anonymous'}
                          </span>
                          <span>{dateFormatted}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Drawer Footer */}
        <div className="p-3 bg-white border-t border-slate-200 text-center shrink-0">
          <p className="text-[11px] text-slate-500">
            For urgent exam day inquiries, call toll-free <strong>+91-XXXXXXXXXX</strong> or email{' '}
            <strong className="text-[#0B254E]">support@eltnoy.com</strong>.
          </p>
        </div>
      </div>
    </>
  );
};
