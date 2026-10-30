/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  X,
  Building2,
  Users,
  Fingerprint,
  Video,
  CheckCircle2,
  AlertOctagon,
  Clock,
  Search,
  SlidersHorizontal,
  ShieldCheck,
  Server,
  Layers,
  MonitorCheck,
  UserCheck,
  RefreshCw,
  Plus,
} from 'lucide-react';
import {
  INITIAL_CENTER_PROFILES,
  INITIAL_SLOTS,
  INITIAL_BIOMETRIC_RECORDS,
  INITIAL_PROCTORS,
  calculateInstituteOverview,
  filterBiometrics,
  updateBiometricRecordStatus,
  BiometricRecord,
  ExamSlot,
  ProctorAssignment,
} from '../utils/instituteLogic';

interface InstituteDashboardModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenAiProctoring?: () => void;
}

export const InstituteDashboardModal: React.FC<InstituteDashboardModalProps> = ({
  isOpen,
  onClose,
  onOpenAiProctoring,
}) => {
  const [selectedCenterCode, setSelectedCenterCode] = useState('ELT-DL-01');
  const [activeTab, setActiveTab] = useState<'slots' | 'seats' | 'biometric' | 'proctors'>('biometric');
  const [slots, setSlots] = useState<ExamSlot[]>(INITIAL_SLOTS);
  const [biometrics, setBiometrics] = useState<BiometricRecord[]>(INITIAL_BIOMETRIC_RECORDS);
  const [proctors, setProctors] = useState<ProctorAssignment[]>(INITIAL_PROCTORS);
  const [bioFilter, setBioFilter] = useState<'ALL' | 'VERIFIED' | 'PENDING' | 'FLAGGED'>('ALL');
  const [bioSearch, setBioSearch] = useState('');
  const [selectedLabRoom, setSelectedLabRoom] = useState('Lab Alpha (Hall 1)');
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  if (!isOpen) return null;

  const currentCenter =
    INITIAL_CENTER_PROFILES.find((c) => c.centerCode === selectedCenterCode) ||
    INITIAL_CENTER_PROFILES[0];

  const overview = calculateInstituteOverview(currentCenter, slots, biometrics);
  const filteredBiometrics = filterBiometrics(biometrics, bioFilter, bioSearch);

  const handleAdmitCandidate = (recId: string) => {
    setBiometrics((prev) => updateBiometricRecordStatus(prev, recId, 'Verified & Admitted'));
    setActionNotice('Candidate admitted through superintendent manual biometric override.');
    setTimeout(() => setActionNotice(null), 4000);
  };

  const handleFlagCandidate = (recId: string) => {
    setBiometrics((prev) => updateBiometricRecordStatus(prev, recId, 'Biometric Mismatch Flag'));
    setActionNotice('Candidate flagged for secondary biometric and photo audit.');
    setTimeout(() => setActionNotice(null), 4000);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="institute-dashboard-title"
      className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/80 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5"
    >
      <div className="bg-white rounded-2xl shadow-2xl max-w-6xl w-full border border-slate-200 overflow-hidden flex flex-col max-h-[92vh] animate-in fade-in zoom-in-95 duration-150">
        {/* Top Institutional Header */}
        <div className="bg-[#0B254E] text-white px-6 py-4 flex flex-wrap items-center justify-between border-b border-sky-900 gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-teal-500/20 border border-teal-400/30 flex items-center justify-center text-teal-300">
              <Building2 className="w-6 h-6 stroke-[2.2]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 id="institute-dashboard-title" className="text-lg font-bold tracking-tight">
                  Institute Administration &amp; Center Command Portal
                </h2>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-teal-500/20 text-teal-300 border border-teal-400/30">
                  Center Node: {currentCenter.centerCode}
                </span>
              </div>
              <p className="text-xs text-sky-200">
                Authorized Test Center &amp; University Administrative Console · Session Shift 1
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Live AI Proctoring Action CTA */}
            {onOpenAiProctoring && (
              <button
                onClick={() => {
                  onClose();
                  onOpenAiProctoring();
                }}
                className="px-3.5 py-1.5 bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold rounded-lg flex items-center gap-1.5 shadow-xs transition-colors"
              >
                <Video className="w-3.5 h-3.5" />
                <span>Launch AI Proctoring Grid</span>
              </button>
            )}

            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-white/10 transition-colors"
              aria-label="Close Institute Dashboard"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Center Selector & System Vitals Bar */}
        <div className="bg-slate-50 border-b border-slate-200 px-6 py-3 flex flex-wrap items-center justify-between gap-4 text-xs">
          <div className="flex items-center gap-3">
            <label htmlFor="center-picker" className="font-bold text-slate-700 whitespace-nowrap">
              Test Center Facility:
            </label>
            <select
              id="center-picker"
              value={selectedCenterCode}
              onChange={(e) => setSelectedCenterCode(e.target.value)}
              className="px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-semibold text-slate-800 focus:outline-hidden focus:ring-2 focus:ring-[#16A34A]"
            >
              {INITIAL_CENTER_PROFILES.map((c) => (
                <option key={c.centerCode} value={c.centerCode}>
                  {c.centerName} ({c.centerCode}) - {c.city}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-4 text-slate-600 font-medium">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-500" />
              <span>Surveillance: <strong className="text-slate-800">{currentCenter.cctvSurveillanceStatus}</strong></span>
            </div>
            <div className="hidden sm:flex items-center gap-1.5">
              <Server className="w-3.5 h-3.5 text-slate-400" />
              <span>Bandwidth: <strong className="text-slate-800">{currentCenter.bandwidthSpeedMbps} Mbps Dedicated</strong></span>
            </div>
            <div className="hidden md:flex items-center gap-1.5">
              <Fingerprint className="w-3.5 h-3.5 text-teal-600" />
              <span>Biometric Desks: <strong className="text-slate-800">{currentCenter.activeBiometricStations} Active</strong></span>
            </div>
          </div>
        </div>

        {/* Notice Ribbon */}
        {actionNotice && (
          <div className="bg-emerald-50 border-b border-emerald-200 px-6 py-2 text-xs text-emerald-800 font-semibold flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>{actionNotice}</span>
          </div>
        )}

        {/* Real-time KPI Ribbon */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 p-4 sm:px-6 bg-slate-100/70 border-b border-slate-200 text-xs">
          <div className="bg-white p-3 rounded-xl border border-slate-200/90 shadow-2xs">
            <div className="text-slate-500 font-bold uppercase text-[10px]">Allocated Capacity</div>
            <div className="text-xl font-black text-[#0B254E] mt-0.5">{overview.totalAllocated} Candidates</div>
            <div className="text-[10px] text-slate-500 mt-1">Shift 1 (09:00 - 12:00)</div>
          </div>

          <div className="bg-white p-3 rounded-xl border border-emerald-200 shadow-2xs">
            <div className="text-emerald-700 font-bold uppercase text-[10px]">Biometric Admitted</div>
            <div className="text-xl font-black text-emerald-600 mt-0.5">{overview.verifiedCount} Candidates</div>
            <div className="text-[10px] text-emerald-600 mt-1">Check-in Rate: 86.4%</div>
          </div>

          <div className="bg-white p-3 rounded-xl border border-amber-200 shadow-2xs">
            <div className="text-amber-700 font-bold uppercase text-[10px]">Pending Check-in</div>
            <div className="text-xl font-black text-amber-600 mt-0.5">{overview.pendingCount} Candidates</div>
            <div className="text-[10px] text-amber-700 mt-1">Queued at Gates 1 &amp; 2</div>
          </div>

          <div className="bg-white p-3 rounded-xl border border-rose-200 shadow-2xs">
            <div className="text-rose-700 font-bold uppercase text-[10px]">Biometric Flags</div>
            <div className="text-xl font-black text-rose-600 mt-0.5">{overview.flaggedCount} Review Required</div>
            <div className="text-[10px] text-rose-600 mt-1">Special Desk Escalation</div>
          </div>

          <div className="bg-white p-3 rounded-xl border border-slate-200/90 shadow-2xs col-span-2 sm:col-span-1">
            <div className="text-slate-500 font-bold uppercase text-[10px]">Staff on Duty</div>
            <div className="text-xl font-black text-teal-700 mt-0.5">{overview.invigilatorsOnDuty} Staff</div>
            <div className="text-[10px] text-teal-600 mt-1">100% Roster Checked In</div>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-slate-200 px-6 gap-2 bg-white text-xs font-bold text-slate-600">
          <button
            onClick={() => setActiveTab('biometric')}
            className={`py-3 px-4 border-b-2 flex items-center gap-2 transition-colors ${
              activeTab === 'biometric'
                ? 'border-[#16A34A] text-[#16A34A]'
                : 'border-transparent hover:text-slate-900'
            }`}
          >
            <Fingerprint className="w-4 h-4" />
            <span>Biometric Verification Check-in Log ({biometrics.length})</span>
          </button>

          <button
            onClick={() => setActiveTab('slots')}
            className={`py-3 px-4 border-b-2 flex items-center gap-2 transition-colors ${
              activeTab === 'slots'
                ? 'border-[#16A34A] text-[#16A34A]'
                : 'border-transparent hover:text-slate-900'
            }`}
          >
            <Clock className="w-4 h-4" />
            <span>Allocated Exam Slots &amp; Shifts</span>
          </button>

          <button
            onClick={() => setActiveTab('seats')}
            className={`py-3 px-4 border-b-2 flex items-center gap-2 transition-colors ${
              activeTab === 'seats'
                ? 'border-[#16A34A] text-[#16A34A]'
                : 'border-transparent hover:text-slate-900'
            }`}
          >
            <Layers className="w-4 h-4" />
            <span>Seat Configuration &amp; Lab Matrix</span>
          </button>

          <button
            onClick={() => setActiveTab('proctors')}
            className={`py-3 px-4 border-b-2 flex items-center gap-2 transition-colors ${
              activeTab === 'proctors'
                ? 'border-[#16A34A] text-[#16A34A]'
                : 'border-transparent hover:text-slate-900'
            }`}
          >
            <Users className="w-4 h-4" />
            <span>Proctor &amp; Invigilator Assignments</span>
          </button>
        </div>

        {/* Tab Content Body */}
        <div className="overflow-y-auto p-5 sm:p-6 flex-1 bg-slate-50/50">
          {/* TAB 1: Biometric Verification Check-in Log */}
          {activeTab === 'biometric' && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 bg-white p-3.5 rounded-xl border border-slate-200">
                <div className="flex items-center gap-2 flex-1 min-w-[240px]">
                  <Search className="w-4 h-4 text-slate-400" />
                  <input
                    type="text"
                    value={bioSearch}
                    onChange={(e) => setBioSearch(e.target.value)}
                    placeholder="Search candidate name, roll number, or desk station..."
                    className="w-full text-xs bg-transparent focus:outline-hidden text-slate-800"
                  />
                  {bioSearch && (
                    <button onClick={() => setBioSearch('')} className="text-slate-400 hover:text-slate-600">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-1.5 text-xs font-semibold">
                  <span className="text-slate-500 mr-1">Status:</span>
                  {(['ALL', 'VERIFIED', 'PENDING', 'FLAGGED'] as const).map((filter) => (
                    <button
                      key={filter}
                      onClick={() => setBioFilter(filter)}
                      className={`px-2.5 py-1 rounded-md text-[11px] transition-colors ${
                        bioFilter === filter
                          ? 'bg-[#0B254E] text-white'
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      }`}
                    >
                      {filter}
                    </button>
                  ))}
                </div>
              </div>

              {/* Candidates Table */}
              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-2xs">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-left">
                    <thead className="bg-slate-100 text-slate-700 font-bold uppercase tracking-wider text-[11px]">
                      <tr>
                        <th className="py-2.5 px-4">Candidate &amp; Roll Number</th>
                        <th className="py-2.5 px-3">Station &amp; Room</th>
                        <th className="py-2.5 px-3 text-center">Fingerprint Match</th>
                        <th className="py-2.5 px-3 text-center">Photo Biometric</th>
                        <th className="py-2.5 px-3">Timestamp</th>
                        <th className="py-2.5 px-3">Status</th>
                        <th className="py-2.5 px-3 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {filteredBiometrics.map((rec) => (
                        <tr key={rec.id} className="hover:bg-slate-50 transition-colors">
                          <td className="py-3 px-4">
                            <div className="font-bold text-slate-900">{rec.candidateName}</div>
                            <div className="font-mono text-[11px] text-slate-500 flex items-center gap-2">
                              <span>{rec.rollNumber}</span>
                              <span className="px-1.5 py-0.2 rounded bg-slate-100 text-slate-700 font-semibold">
                                Seat: {rec.seatNumber}
                              </span>
                            </div>
                          </td>
                          <td className="py-3 px-3">
                            <div className="font-medium text-slate-800">{rec.deskStation}</div>
                            <div className="text-[11px] text-slate-500">{rec.labRoom}</div>
                          </td>
                          <td className="py-3 px-3 text-center">
                            {rec.fingerprintMatchPercent > 0 ? (
                              <span
                                className={`font-mono font-bold ${
                                  rec.fingerprintMatchPercent >= 90
                                    ? 'text-emerald-700'
                                    : 'text-rose-600'
                                }`}
                              >
                                {rec.fingerprintMatchPercent}%
                              </span>
                            ) : (
                              <span className="text-slate-400 font-mono">-</span>
                            )}
                          </td>
                          <td className="py-3 px-3 text-center">
                            {rec.photoMatchPercent > 0 ? (
                              <span
                                className={`font-mono font-bold ${
                                  rec.photoMatchPercent >= 90
                                    ? 'text-emerald-700'
                                    : 'text-rose-600'
                                }`}
                              >
                                {rec.photoMatchPercent}%
                              </span>
                            ) : (
                              <span className="text-slate-400 font-mono">-</span>
                            )}
                          </td>
                          <td className="py-3 px-3 text-slate-600 font-mono text-[11px]">
                            {rec.checkInTimestamp}
                          </td>
                          <td className="py-3 px-3">
                            {rec.status === 'Verified & Admitted' && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800">
                                <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                                Admitted
                              </span>
                            )}
                            {rec.status === 'Pending Verification' && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800">
                                <Clock className="w-3 h-3 text-amber-600" />
                                Pending
                              </span>
                            )}
                            {rec.status === 'Biometric Mismatch Flag' && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-100 text-rose-800">
                                <AlertOctagon className="w-3 h-3 text-rose-600" />
                                Mismatch Flag
                              </span>
                            )}
                          </td>
                          <td className="py-3 px-3 text-right">
                            {rec.status !== 'Verified & Admitted' ? (
                              <button
                                onClick={() => handleAdmitCandidate(rec.id)}
                                className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-[11px] font-bold transition-colors"
                              >
                                Override &amp; Admit
                              </button>
                            ) : (
                              <button
                                onClick={() => handleFlagCandidate(rec.id)}
                                className="px-2.5 py-1 bg-slate-100 hover:bg-rose-50 hover:text-rose-700 text-slate-600 rounded text-[11px] font-semibold border border-slate-200 transition-colors"
                              >
                                Re-verify
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: Allocated Exam Slots */}
          {activeTab === 'slots' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {slots.map((slot) => (
                  <div key={slot.id} className="bg-white rounded-xl border border-slate-200 p-5 shadow-xs space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-sky-100 text-sky-800 uppercase">
                        {slot.shiftName} · {slot.examCode}
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                          slot.status === 'Live CBT Session'
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-slate-100 text-slate-700'
                        }`}
                      >
                        {slot.status}
                      </span>
                    </div>

                    <div>
                      <h4 className="text-sm font-bold text-slate-900">{slot.examName}</h4>
                      <p className="text-xs text-slate-500 flex items-center gap-1.5 mt-0.5">
                        <Clock className="w-3.5 h-3.5 text-slate-400" />
                        <span>Scheduled Timing: <strong>{slot.timeRange}</strong></span>
                      </p>
                    </div>

                    <div className="space-y-1.5">
                      <div className="flex justify-between text-xs text-slate-600 font-semibold">
                        <span>Check-in Utilization:</span>
                        <span>{slot.checkedInCount} / {slot.totalAllocatedSeats} Seats</span>
                      </div>
                      <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
                        <div
                          className="bg-[#16A34A] h-full rounded-full"
                          style={{
                            width: `${Math.min(100, (slot.checkedInCount / slot.totalAllocatedSeats) * 100)}%`,
                          }}
                        />
                      </div>
                    </div>

                    {/* Room Breakdown */}
                    <div className="border-t border-slate-100 pt-3 space-y-1.5">
                      <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                        Lab Room Allocations
                      </div>
                      {slot.labRooms.map((room, idx) => (
                        <div key={idx} className="flex items-center justify-between text-xs py-1 px-2 rounded bg-slate-50">
                          <div>
                            <span className="font-semibold text-slate-800">{room.roomName}</span>
                            <span className="text-[10px] text-slate-500 block">Invigilator: {room.proctorAssigned}</span>
                          </div>
                          <span className="font-mono text-slate-700 font-medium">
                            {room.occupied} / {room.capacity}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* TAB 3: Seat Configuration & Lab Matrix */}
          {activeTab === 'seats' && (
            <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-slate-700">Active Lab:</span>
                  <select
                    value={selectedLabRoom}
                    onChange={(e) => setSelectedLabRoom(e.target.value)}
                    className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs font-semibold text-slate-800"
                  >
                    <option value="Lab Alpha (Hall 1)">Lab Alpha (Hall 1) - 150 Workstations</option>
                    <option value="Lab Beta (Hall 2)">Lab Beta (Hall 2) - 150 Workstations</option>
                    <option value="Lab Gamma (Hall 3)">Lab Gamma (Hall 3) - 200 Workstations</option>
                  </select>
                </div>

                <div className="flex items-center gap-3 text-xs">
                  <span className="flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded bg-emerald-500" /> Occupied &amp; Active
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded bg-slate-200" /> Vacant
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded bg-purple-400" /> Reserved (PwD / Wheelchair)
                  </span>
                </div>
              </div>

              {/* Visual Seat Grid (40 terminals preview) */}
              <div>
                <div className="text-xs font-bold text-slate-600 mb-2">Workstation Terminal Topology (Row A through D):</div>
                <div className="grid grid-cols-5 sm:grid-cols-10 gap-2">
                  {Array.from({ length: 40 }).map((_, i) => {
                    const seatCode = `A-${(i + 1).toString().padStart(3, '0')}`;
                    const isReserved = i === 4 || i === 9;
                    const isOccupied = i < 28 && !isReserved;
                    return (
                      <div
                        key={i}
                        className={`p-2 rounded-lg text-center border text-[11px] font-mono transition-transform hover:scale-105 cursor-pointer ${
                          isOccupied
                            ? 'bg-emerald-50 border-emerald-300 text-emerald-900 font-bold'
                            : isReserved
                            ? 'bg-purple-50 border-purple-300 text-purple-900 font-semibold'
                            : 'bg-slate-50 border-slate-200 text-slate-400'
                        }`}
                        title={`Terminal ${seatCode} - ${isOccupied ? 'CBT Active' : isReserved ? 'Reserved' : 'Vacant'}`}
                      >
                        <div>{seatCode}</div>
                        <div className="text-[9px] uppercase tracking-tighter mt-0.5">
                          {isOccupied ? 'ACTIVE' : isReserved ? 'PWD' : 'VACANT'}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: Proctor & Invigilator Assignments */}
          {activeTab === 'proctors' && (
            <div className="space-y-4">
              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-2xs">
                <table className="w-full text-xs text-left">
                  <thead className="bg-slate-100 text-slate-700 font-bold uppercase tracking-wider text-[11px]">
                    <tr>
                      <th className="py-2.5 px-4">Staff Member &amp; ID</th>
                      <th className="py-2.5 px-3">Role Designation</th>
                      <th className="py-2.5 px-3">Assigned Room / Zone</th>
                      <th className="py-2.5 px-3">Supervised Nodes</th>
                      <th className="py-2.5 px-3">Contact</th>
                      <th className="py-2.5 px-3 text-right">Duty Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {proctors.map((proc) => (
                      <tr key={proc.id} className="hover:bg-slate-50">
                        <td className="py-3 px-4">
                          <div className="font-bold text-slate-900">{proc.staffName}</div>
                          <div className="font-mono text-[11px] text-slate-500">{proc.staffId}</div>
                        </td>
                        <td className="py-3 px-3">
                          <span className="font-semibold text-[#0B254E]">{proc.role}</span>
                        </td>
                        <td className="py-3 px-3 text-slate-700 font-medium">
                          {proc.assignedRoom}
                        </td>
                        <td className="py-3 px-3 font-mono text-slate-600">
                          {proc.activeTerminalCount} Nodes
                        </td>
                        <td className="py-3 px-3 font-mono text-slate-500 text-[11px]">
                          {proc.contactNumber}
                        </td>
                        <td className="py-3 px-3 text-right">
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800">
                            <UserCheck className="w-3 h-3 text-emerald-600" />
                            {proc.dutyStatus}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="bg-slate-50 border-t border-slate-200 px-6 py-3.5 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="text-slate-500 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-600" />
            <span>Center Node certified for High-Security CBT Operations under ISO/IEC 27001 standard.</span>
          </div>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-[#0B254E] hover:bg-[#071933] text-white rounded-lg text-xs font-bold transition-colors shadow-xs"
          >
            Dismiss Console
          </button>
        </div>
      </div>
    </div>
  );
};
