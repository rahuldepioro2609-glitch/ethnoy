/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  X,
  Video,
  ShieldAlert,
  AlertTriangle,
  CheckCircle2,
  Bell,
  Eye,
  Radio,
  Volume2,
  Smartphone,
  Pause,
  Play,
  UserX,
  Send,
  RefreshCw,
  Sliders,
  ShieldCheck,
  Maximize2,
  Flame,
} from 'lucide-react';
import {
  INITIAL_PROCTORED_CANDIDATES,
  INITIAL_INCIDENTS,
  issueWarningToCandidate,
  updateCandidateStatus,
  resolveProctorIncident,
  ProctoredCandidate,
  ProctorIncident,
} from '../utils/proctorLogic';

interface AiProctoringModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const AiProctoringModal: React.FC<AiProctoringModalProps> = ({ isOpen, onClose }) => {
  const [candidates, setCandidates] = useState<ProctoredCandidate[]>(INITIAL_PROCTORED_CANDIDATES);
  const [incidents, setIncidents] = useState<ProctorIncident[]>(INITIAL_INCIDENTS);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string>('cand-03');
  const [broadcastMessage, setBroadcastMessage] = useState('');
  const [targetedWarning, setTargetedWarning] = useState('');
  const [severityFilter, setSeverityFilter] = useState<'ALL' | 'HIGH' | 'MEDIUM' | 'LOW'>('ALL');
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  if (!isOpen) return null;

  const selectedCandidate =
    candidates.find((c) => c.id === selectedCandidateId) || candidates[0];

  const handleBroadcast = (e: React.FormEvent) => {
    e.preventDefault();
    if (!broadcastMessage.trim()) return;
    setToastMessage(`Invigilator broadcast dispatched to all active exam halls: "${broadcastMessage}"`);
    setBroadcastMessage('');
    setTimeout(() => setToastMessage(null), 5000);
  };

  const handleSendTargetedWarning = () => {
    if (!targetedWarning.trim()) return;
    setCandidates((prev) => issueWarningToCandidate(prev, selectedCandidate.id, targetedWarning));
    setToastMessage(`Official warning sent to ${selectedCandidate.name} (${selectedCandidate.rollNumber}): "${targetedWarning}"`);
    setTargetedWarning('');
    setTimeout(() => setToastMessage(null), 5000);
  };

  const handleStatusChange = (status: 'Active' | 'Paused' | 'Terminated') => {
    setCandidates((prev) => updateCandidateStatus(prev, selectedCandidate.id, status));
    setToastMessage(`Candidate ${selectedCandidate.name} exam status set to: ${status.toUpperCase()}`);
    setTimeout(() => setToastMessage(null), 5000);
  };

  const handleResolveIncident = (incId: string) => {
    setIncidents((prev) =>
      resolveProctorIncident(prev, incId, 'Cleared by Invigilator after video verification.')
    );
    setToastMessage('Incident resolved and archived into examination audit log.');
    setTimeout(() => setToastMessage(null), 4000);
  };

  const filteredIncidents = incidents.filter((inc) => {
    if (severityFilter === 'ALL') return true;
    return inc.severity === severityFilter;
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="proctor-modal-title"
      className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/85 backdrop-blur-xs flex items-center justify-center p-2 sm:p-4"
    >
      <div className="bg-[#0A1120] text-slate-100 rounded-2xl shadow-2xl max-w-6xl w-full border border-slate-800 overflow-hidden flex flex-col max-h-[94vh] animate-in fade-in zoom-in-95 duration-150">
        {/* Header Bar */}
        <div className="bg-[#0F172A] px-5 py-3.5 flex items-center justify-between border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-rose-500/20 border border-rose-500/30 flex items-center justify-center text-rose-400">
              <Video className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 id="proctor-modal-title" className="text-base font-bold tracking-tight text-white">
                  AI Proctoring &amp; Real-Time Incident Command Room
                </h2>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-500/20 text-rose-300 border border-rose-500/30 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                  LIVE TELEMETRY
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Multi-Modal Neural Vision &amp; Audio Anomaly Monitoring · 6 Active Feeds in Lab Alpha
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center gap-2 text-xs font-mono bg-slate-900/80 px-3 py-1.5 rounded-lg border border-slate-800 text-slate-400">
              <Radio className="w-3.5 h-3.5 text-emerald-400" />
              <span>FPS: 30 · Model: VisionProctor-v4.2</span>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              aria-label="Close Proctoring View"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Global Toast Alert */}
        {toastMessage && (
          <div className="bg-emerald-950/80 border-b border-emerald-800 px-5 py-2 text-xs text-emerald-300 font-semibold flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{toastMessage}</span>
          </div>
        )}

        {/* Invigilator Global Broadcast Strip */}
        <div className="bg-[#0D1526] border-b border-slate-800 px-5 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs">
          <form onSubmit={handleBroadcast} className="flex items-center gap-2 flex-1 max-w-xl">
            <Bell className="w-4 h-4 text-amber-400 shrink-0" />
            <input
              type="text"
              value={broadcastMessage}
              onChange={(e) => setBroadcastMessage(e.target.value)}
              placeholder="Broadcast audio/screen alert to all candidates (e.g., '10 minutes remaining in Section 1')..."
              className="w-full text-xs bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-white placeholder-slate-500 focus:outline-hidden focus:border-amber-400 font-medium"
            />
            <button
              type="submit"
              className="px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold rounded-lg transition-colors shrink-0 flex items-center gap-1"
            >
              <Send className="w-3 h-3" />
              <span>Broadcast</span>
            </button>
          </form>

          <div className="flex items-center gap-3 text-[11px] text-slate-400">
            <span>Critical Flags: <strong className="text-rose-400">1</strong></span>
            <span>Warnings: <strong className="text-amber-400">2</strong></span>
            <span>Clean: <strong className="text-emerald-400">3</strong></span>
          </div>
        </div>

        {/* Main Split Grid: Left Feeds Grid (7 cols) + Right Telemetry & Actions (5 cols) */}
        <div className="grid grid-cols-1 lg:grid-cols-12 flex-1 overflow-y-auto divide-y lg:divide-y-0 lg:divide-x divide-slate-800">
          {/* LEFT: 6-Candidate Live Webcam Grid */}
          <div className="lg:col-span-7 p-4 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
                Candidate Live Video Mesh Feeds (Lab Alpha)
              </span>
              <span className="text-[11px] text-slate-500">Click a stream to inspect &amp; intervene</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {candidates.map((cand) => {
                const isSelected = cand.id === selectedCandidate.id;
                const isFlagged = cand.flagStatus === 'CRITICAL';
                const isWarning = cand.flagStatus === 'WARNING';

                return (
                  <div
                    key={cand.id}
                    onClick={() => setSelectedCandidateId(cand.id)}
                    className={`relative rounded-xl overflow-hidden border cursor-pointer transition-all ${
                      isSelected
                        ? 'ring-2 ring-emerald-500 border-emerald-400 shadow-lg'
                        : isFlagged
                        ? 'border-rose-500/80 bg-rose-950/20'
                        : isWarning
                        ? 'border-amber-500/80 bg-amber-950/20'
                        : 'border-slate-800 bg-slate-900/60 hover:border-slate-700'
                    }`}
                  >
                    {/* Simulated Webcam Viewport */}
                    <div className="relative aspect-4/3 bg-slate-900 flex items-center justify-center overflow-hidden">
                      {/* Stylized Avatar Silhouette representing the candidate's camera feed */}
                      <div className="w-20 h-20 rounded-full bg-slate-800 border-2 border-slate-700 flex items-center justify-center text-slate-400 relative">
                        <span className="text-2xl font-black">{cand.name.charAt(0)}</span>
                        {/* Animated Face Tracking Box Overlay */}
                        <div
                          className={`absolute inset-0 rounded-lg border-2 ${
                            isFlagged
                              ? 'border-rose-500'
                              : isWarning
                              ? 'border-amber-400'
                              : 'border-emerald-400/80'
                          }`}
                        />
                      </div>

                      {/* Top Overlay Badges */}
                      <div className="absolute top-2 left-2 flex items-center gap-1.5">
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-black/70 text-slate-200">
                          {cand.deskNumber}
                        </span>
                        {cand.examStatus !== 'Active' && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-rose-600 text-white">
                            {cand.examStatus}
                          </span>
                        )}
                      </div>

                      <div className="absolute top-2 right-2">
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                            cand.trustScore >= 90
                              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                              : cand.trustScore >= 75
                              ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                              : 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                          }`}
                        >
                          Trust: {cand.trustScore}%
                        </span>
                      </div>

                      {/* Anomaly Indicator Pills Bottom Overlay */}
                      <div className="absolute bottom-2 left-2 right-2 flex flex-wrap gap-1">
                        {cand.faceStatus !== 'Normal' && (
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-rose-900/90 text-rose-200 border border-rose-700/50 flex items-center gap-0.5">
                            <AlertTriangle className="w-2.5 h-2.5" />
                            {cand.faceStatus}
                          </span>
                        )}
                        {cand.tabSwitchCount > 0 && (
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-900/90 text-amber-200 border border-amber-700/50">
                            Tab Switch: {cand.tabSwitchCount}x
                          </span>
                        )}
                        {cand.audioAnomaly && (
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-purple-900/90 text-purple-200 border border-purple-700/50 flex items-center gap-0.5">
                            <Volume2 className="w-2.5 h-2.5" /> Audio Flag
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Candidate Identity Strip */}
                    <div className="p-2.5 bg-slate-900/90 border-t border-slate-800 text-xs">
                      <div className="font-bold text-white truncate">{cand.name}</div>
                      <div className="text-[11px] font-mono text-slate-400 truncate">{cand.rollNumber}</div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Live Incidents Timeline Table */}
            <div className="border border-slate-800 rounded-xl bg-slate-900/50 overflow-hidden">
              <div className="bg-slate-900 px-4 py-2.5 flex items-center justify-between border-b border-slate-800">
                <div className="flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4 text-amber-400" />
                  <span className="text-xs font-bold text-white">Live Incident Feed &amp; Audit Log</span>
                </div>
                <div className="flex items-center gap-1 text-[11px]">
                  {(['ALL', 'HIGH', 'MEDIUM', 'LOW'] as const).map((sev) => (
                    <button
                      key={sev}
                      onClick={() => setSeverityFilter(sev)}
                      className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-colors ${
                        severityFilter === sev
                          ? 'bg-slate-700 text-white'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      {sev}
                    </button>
                  ))}
                </div>
              </div>

              <div className="divide-y divide-slate-800/80 max-h-48 overflow-y-auto text-xs">
                {filteredIncidents.map((inc) => (
                  <div key={inc.id} className="p-3 flex items-start justify-between gap-3 hover:bg-slate-800/30">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[10px] text-slate-500">{inc.timestamp}</span>
                        <span
                          className={`px-1.5 py-0.2 rounded text-[9px] font-bold ${
                            inc.severity === 'HIGH'
                              ? 'bg-rose-900/70 text-rose-300'
                              : inc.severity === 'MEDIUM'
                              ? 'bg-amber-900/70 text-amber-300'
                              : 'bg-slate-800 text-slate-300'
                          }`}
                        >
                          {inc.severity}
                        </span>
                        <span className="font-bold text-white">{inc.candidateName}</span>
                        <span className="font-mono text-slate-400 text-[11px]">({inc.deskNumber})</span>
                      </div>
                      <p className="text-slate-300 text-xs">{inc.description}</p>
                      {inc.actionTaken && (
                        <p className="text-emerald-400 text-[11px]">Action: {inc.actionTaken}</p>
                      )}
                    </div>

                    {!inc.resolved ? (
                      <button
                        onClick={() => handleResolveIncident(inc.id)}
                        className="px-2 py-1 bg-slate-800 hover:bg-emerald-700 text-slate-300 hover:text-white rounded text-[10px] font-semibold transition-colors shrink-0"
                      >
                        Clear Flag
                      </button>
                    ) : (
                      <span className="text-[10px] text-emerald-400 font-semibold shrink-0 flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" /> Resolved
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* RIGHT: Selected Candidate Telemetry & Actions Drawer */}
          <div className="lg:col-span-5 p-5 space-y-5 bg-[#0D1526]/40">
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
                  Focused Candidate Diagnostic
                </span>
                <span className="font-mono text-xs text-emerald-400 font-bold">
                  {selectedCandidate.deskNumber}
                </span>
              </div>
              <h3 className="text-base font-bold text-white mt-1">{selectedCandidate.name}</h3>
              <p className="text-xs font-mono text-slate-400">
                Roll: {selectedCandidate.rollNumber} · IP: {selectedCandidate.ipAddress}
              </p>
            </div>

            {/* Diagnostic Meters */}
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="bg-slate-900 p-3 rounded-xl border border-slate-800">
                <div className="text-slate-400 text-[10px] uppercase font-bold">Trust Integrity Score</div>
                <div className="text-2xl font-black text-white mt-0.5">{selectedCandidate.trustScore}%</div>
                <div className="w-full bg-slate-800 h-1.5 rounded-full mt-2 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${
                      selectedCandidate.trustScore >= 90
                        ? 'bg-emerald-500'
                        : selectedCandidate.trustScore >= 75
                        ? 'bg-amber-500'
                        : 'bg-rose-500'
                    }`}
                    style={{ width: `${selectedCandidate.trustScore}%` }}
                  />
                </div>
              </div>

              <div className="bg-slate-900 p-3 rounded-xl border border-slate-800">
                <div className="text-slate-400 text-[10px] uppercase font-bold">Face Mesh Status</div>
                <div
                  className={`text-sm font-bold mt-1.5 ${
                    selectedCandidate.faceStatus === 'Normal' ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {selectedCandidate.faceStatus}
                </div>
                <div className="text-[10px] text-slate-400 mt-1">Gaze Deviation: 4° Yaw</div>
              </div>

              <div className="bg-slate-900 p-3 rounded-xl border border-slate-800">
                <div className="text-slate-400 text-[10px] uppercase font-bold">Tab Violations</div>
                <div className="text-2xl font-black text-amber-400 mt-0.5">
                  {selectedCandidate.tabSwitchCount} Switches
                </div>
                <div className="text-[10px] text-slate-400 mt-1">Browser Fullscreen Guard Active</div>
              </div>

              <div className="bg-slate-900 p-3 rounded-xl border border-slate-800">
                <div className="text-slate-400 text-[10px] uppercase font-bold">Audio Level (RMS)</div>
                <div className="text-2xl font-black text-white mt-0.5">
                  {selectedCandidate.audioAnomaly ? '54 dB (High)' : '28 dB (Quiet)'}
                </div>
                <div className="text-[10px] text-slate-400 mt-1">Acoustic fingerprint monitored</div>
              </div>
            </div>

            {/* Telemetry Log */}
            <div className="bg-slate-900 p-3.5 rounded-xl border border-slate-800 text-xs space-y-1">
              <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                Real-Time Telemetry Feed
              </div>
              <p className="text-slate-300 font-mono text-[11px] leading-relaxed">
                {selectedCandidate.lastTelemetry}
              </p>
            </div>

            {/* Invigilator Action Intervention Buttons */}
            <div className="space-y-3">
              <div className="text-xs font-bold text-slate-300 uppercase tracking-wider">
                Invigilator Action Controls
              </div>

              {/* Targeted Warning Form */}
              <div className="space-y-1.5">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={targetedWarning}
                    onChange={(e) => setTargetedWarning(e.target.value)}
                    placeholder="Custom warning (e.g., 'Please look straight at your screen')..."
                    className="flex-1 text-xs bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white placeholder-slate-500 focus:outline-hidden focus:border-rose-400"
                  />
                  <button
                    onClick={handleSendTargetedWarning}
                    className="px-3 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-bold transition-colors shrink-0"
                  >
                    Issue Warning
                  </button>
                </div>

                <div className="flex flex-wrap gap-1.5 text-[10px]">
                  <button
                    onClick={() => setTargetedWarning('Warning 1/3: Do not look away from screen.')}
                    className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
                  >
                    + Gaze Warning
                  </button>
                  <button
                    onClick={() => setTargetedWarning('Warning: Multiple faces detected in frame.')}
                    className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
                  >
                    + Multiple Faces
                  </button>
                  <button
                    onClick={() => setTargetedWarning('Warning: Tab switching is strictly prohibited.')}
                    className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
                  >
                    + Tab Switch
                  </button>
                </div>
              </div>

              {/* State Control Buttons */}
              <div className="grid grid-cols-3 gap-2 pt-2">
                <button
                  onClick={() => handleStatusChange('Active')}
                  className={`py-2 px-2 rounded-lg text-xs font-bold border transition-colors flex items-center justify-center gap-1 ${
                    selectedCandidate.examStatus === 'Active'
                      ? 'bg-emerald-600 border-emerald-500 text-white'
                      : 'bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  <Play className="w-3.5 h-3.5" />
                  <span>Resume</span>
                </button>

                <button
                  onClick={() => handleStatusChange('Paused')}
                  className={`py-2 px-2 rounded-lg text-xs font-bold border transition-colors flex items-center justify-center gap-1 ${
                    selectedCandidate.examStatus === 'Paused'
                      ? 'bg-amber-600 border-amber-500 text-white'
                      : 'bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  <Pause className="w-3.5 h-3.5" />
                  <span>Pause Test</span>
                </button>

                <button
                  onClick={() => handleStatusChange('Terminated')}
                  className={`py-2 px-2 rounded-lg text-xs font-bold border transition-colors flex items-center justify-center gap-1 ${
                    selectedCandidate.examStatus === 'Terminated'
                      ? 'bg-rose-700 border-rose-600 text-white'
                      : 'bg-slate-900 border-slate-700 text-rose-400 hover:bg-rose-950/40'
                  }`}
                >
                  <UserX className="w-3.5 h-3.5" />
                  <span>Disqualify</span>
                </button>
              </div>

              {/* Past Warnings Issued List */}
              {selectedCandidate.warningsIssued.length > 0 && (
                <div className="p-3 bg-rose-950/30 border border-rose-900/60 rounded-xl space-y-1">
                  <div className="text-[10px] font-bold text-rose-400 uppercase tracking-wider">
                    Warnings Logged ({selectedCandidate.warningsIssued.length})
                  </div>
                  {selectedCandidate.warningsIssued.map((w, idx) => (
                    <div key={idx} className="text-[11px] text-rose-200">
                      • {w}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="bg-[#0F172A] border-t border-slate-800 px-5 py-3 flex items-center justify-between text-xs text-slate-400">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <span>AI Proctoring Stream encrypted via AES-256 with biometric evidentiary tamper audit trail.</span>
          </div>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-white font-semibold rounded-lg transition-colors"
          >
            Close Incident Room
          </button>
        </div>
      </div>
    </div>
  );
};
