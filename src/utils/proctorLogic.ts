/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ProctoredCandidate {
  id: string;
  rollNumber: string;
  name: string;
  deskNumber: string;
  ipAddress: string;
  trustScore: number; // 0 - 100
  faceStatus: 'Normal' | 'Face Absent' | 'Multiple Faces' | 'Looking Away';
  tabSwitchCount: number;
  audioAnomaly: boolean;
  deviceAnomaly: boolean;
  flagStatus: 'CLEAR' | 'WARNING' | 'CRITICAL';
  examStatus: 'Active' | 'Paused' | 'Terminated';
  lastTelemetry: string;
  avatarSeed: string;
  warningsIssued: string[];
}

export interface ProctorIncident {
  id: string;
  timestamp: string;
  candidateId: string;
  candidateName: string;
  rollNumber: string;
  deskNumber: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  eventType: 'MULTI_FACE' | 'FACE_ABSENT' | 'TAB_SWITCH' | 'AUDIO_ANOMALY' | 'DEVICE_DETECTED' | 'DISQUALIFIED';
  description: string;
  resolved: boolean;
  actionTaken?: string;
}

export const INITIAL_PROCTORED_CANDIDATES: ProctoredCandidate[] = [
  {
    id: 'cand-01',
    rollNumber: 'ENT-2025-9981',
    name: 'Aarav Sharma',
    deskNumber: 'Desk A-14',
    ipAddress: '192.168.10.14',
    trustScore: 98,
    faceStatus: 'Normal',
    tabSwitchCount: 0,
    audioAnomaly: false,
    deviceAnomaly: false,
    flagStatus: 'CLEAR',
    examStatus: 'Active',
    lastTelemetry: 'Continuous gaze locked on question window. Normal eye jitter.',
    avatarSeed: 'Aarav',
    warningsIssued: [],
  },
  {
    id: 'cand-02',
    rollNumber: 'ENT-2025-4420',
    name: 'Priya Patel',
    deskNumber: 'Desk A-28',
    ipAddress: '192.168.10.28',
    trustScore: 96,
    faceStatus: 'Normal',
    tabSwitchCount: 0,
    audioAnomaly: false,
    deviceAnomaly: false,
    flagStatus: 'CLEAR',
    examStatus: 'Active',
    lastTelemetry: 'Single face detected (99.2% confidence). Ambient noise 32 dB.',
    avatarSeed: 'Priya',
    warningsIssued: [],
  },
  {
    id: 'cand-03',
    rollNumber: 'ENT-2025-8812',
    name: 'Vikram Singh',
    deskNumber: 'Desk B-08',
    ipAddress: '192.168.11.08',
    trustScore: 61,
    faceStatus: 'Multiple Faces',
    tabSwitchCount: 2,
    audioAnomaly: true,
    deviceAnomaly: false,
    flagStatus: 'CRITICAL',
    examStatus: 'Active',
    lastTelemetry: 'Secondary person detected in upper-left quadrant. Whispering audio pattern detected.',
    avatarSeed: 'Vikram',
    warningsIssued: ['Warning: Secondary person detected in camera view.'],
  },
  {
    id: 'cand-04',
    rollNumber: 'ENT-2025-3391',
    name: 'Kavita Menon',
    deskNumber: 'Desk B-42',
    ipAddress: '192.168.11.42',
    trustScore: 82,
    faceStatus: 'Looking Away',
    tabSwitchCount: 1,
    audioAnomaly: false,
    deviceAnomaly: false,
    flagStatus: 'WARNING',
    examStatus: 'Active',
    lastTelemetry: 'Head pitch deviated > 45 degrees toward right side repeatedly.',
    avatarSeed: 'Kavita',
    warningsIssued: [],
  },
  {
    id: 'cand-05',
    rollNumber: 'ENT-2025-7721',
    name: 'Mohammed Tariq',
    deskNumber: 'Desk C-11',
    ipAddress: '192.168.12.11',
    trustScore: 74,
    faceStatus: 'Face Absent',
    tabSwitchCount: 3,
    audioAnomaly: false,
    deviceAnomaly: false,
    flagStatus: 'WARNING',
    examStatus: 'Active',
    lastTelemetry: 'No facial landmarks detected for 14 consecutive frames.',
    avatarSeed: 'Mohammed',
    warningsIssued: ['Warning: Maintain camera visibility.'],
  },
  {
    id: 'cand-06',
    rollNumber: 'ENT-2025-5510',
    name: 'Ananya Deshmukh',
    deskNumber: 'Desk C-35',
    ipAddress: '192.168.12.35',
    trustScore: 99,
    faceStatus: 'Normal',
    tabSwitchCount: 0,
    audioAnomaly: false,
    deviceAnomaly: false,
    flagStatus: 'CLEAR',
    examStatus: 'Active',
    lastTelemetry: 'High lighting stability. Normal keyboard cadence.',
    avatarSeed: 'Ananya',
    warningsIssued: [],
  },
];

export const INITIAL_INCIDENTS: ProctorIncident[] = [
  {
    id: 'inc-101',
    timestamp: '10:14:02 AM',
    candidateId: 'cand-03',
    candidateName: 'Vikram Singh',
    rollNumber: 'ENT-2025-8812',
    deskNumber: 'Desk B-08',
    severity: 'HIGH',
    eventType: 'MULTI_FACE',
    description: 'AI Vision Engine detected 2 distinct face meshes within webcam bounding frame (Confidence: 94.2%).',
    resolved: false,
  },
  {
    id: 'inc-102',
    timestamp: '10:12:45 AM',
    candidateId: 'cand-05',
    candidateName: 'Mohammed Tariq',
    rollNumber: 'ENT-2025-7721',
    deskNumber: 'Desk C-11',
    severity: 'MEDIUM',
    eventType: 'TAB_SWITCH',
    description: 'CBT Lockdown Browser window lost foreground focus (3rd occurrence). Alt-Tab event registered.',
    resolved: false,
  },
  {
    id: 'inc-103',
    timestamp: '10:08:19 AM',
    candidateId: 'cand-04',
    candidateName: 'Kavita Menon',
    rollNumber: 'ENT-2025-3391',
    deskNumber: 'Desk B-42',
    severity: 'LOW',
    eventType: 'FACE_ABSENT',
    description: 'Candidate gaze shifted off-screen for 8.5 seconds.',
    resolved: true,
    actionTaken: 'Invigilator verbal reminder dispatched.',
  },
];

export function calculateCandidateTrustScore(c: Partial<ProctoredCandidate>): number {
  let score = 100;
  if (c.faceStatus === 'Multiple Faces') score -= 30;
  if (c.faceStatus === 'Face Absent') score -= 25;
  if (c.faceStatus === 'Looking Away') score -= 12;
  if (c.tabSwitchCount) score -= c.tabSwitchCount * 8;
  if (c.audioAnomaly) score -= 15;
  if (c.deviceAnomaly) score -= 35;
  return Math.max(10, Math.min(100, score));
}

export function issueWarningToCandidate(
  candidates: ProctoredCandidate[],
  candidateId: string,
  warningText: string
): ProctoredCandidate[] {
  return candidates.map((cand) => {
    if (cand.id === candidateId) {
      const updatedWarnings = [...cand.warningsIssued, warningText];
      const flagStatus = updatedWarnings.length >= 2 ? 'CRITICAL' : 'WARNING';
      return {
        ...cand,
        warningsIssued: updatedWarnings,
        flagStatus,
        trustScore: Math.max(15, cand.trustScore - 10),
      };
    }
    return cand;
  });
}

export function updateCandidateStatus(
  candidates: ProctoredCandidate[],
  candidateId: string,
  status: 'Active' | 'Paused' | 'Terminated'
): ProctoredCandidate[] {
  return candidates.map((cand) => {
    if (cand.id === candidateId) {
      return {
        ...cand,
        examStatus: status,
        flagStatus: status === 'Terminated' ? 'CRITICAL' : cand.flagStatus,
      };
    }
    return cand;
  });
}

export function resolveProctorIncident(
  incidents: ProctorIncident[],
  incidentId: string,
  actionTaken: string
): ProctorIncident[] {
  return incidents.map((inc) => {
    if (inc.id === incidentId) {
      return {
        ...inc,
        resolved: true,
        actionTaken,
      };
    }
    return inc;
  });
}
