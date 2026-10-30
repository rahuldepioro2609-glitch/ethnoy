/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ExamSlot {
  id: string;
  examCode: string;
  examName: string;
  shiftName: string;
  timeRange: string;
  totalAllocatedSeats: number;
  checkedInCount: number;
  status: 'Live CBT Session' | 'Scheduled' | 'Completed';
  labRooms: {
    roomName: string;
    capacity: number;
    occupied: number;
    proctorAssigned: string;
  }[];
}

export interface BiometricRecord {
  id: string;
  rollNumber: string;
  candidateName: string;
  deskStation: string;
  fingerprintMatchPercent: number;
  photoMatchPercent: number;
  checkInTimestamp: string;
  status: 'Verified & Admitted' | 'Pending Verification' | 'Biometric Mismatch Flag';
  labRoom: string;
  seatNumber: string;
}

export interface ProctorAssignment {
  id: string;
  staffName: string;
  staffId: string;
  role: 'Chief Superintendent' | 'Lab Invigilator' | 'Biometric Desk Officer' | 'IT Systems Admin';
  assignedRoom: string;
  dutyStatus: 'On Duty' | 'Standby' | 'Break';
  contactNumber: string;
  activeTerminalCount: number;
}

export interface InstituteCenterProfile {
  centerCode: string;
  centerName: string;
  city: string;
  state: string;
  totalCapacity: number;
  activeBiometricStations: number;
  totalInvigilators: number;
  cctvSurveillanceStatus: 'Active' | 'Degraded' | 'Offline';
  bandwidthSpeedMbps: number;
}

export const INITIAL_CENTER_PROFILES: InstituteCenterProfile[] = [
  {
    centerCode: 'ELT-DL-01',
    centerName: 'ELTNOY Examination Complex - North Zone',
    city: 'New Delhi',
    state: 'Delhi NCR',
    totalCapacity: 750,
    activeBiometricStations: 8,
    totalInvigilators: 24,
    cctvSurveillanceStatus: 'Active',
    bandwidthSpeedMbps: 500,
  },
  {
    centerCode: 'ELT-MH-02',
    centerName: 'ELTNOY Assessment Facility - West Zone',
    city: 'Mumbai',
    state: 'Maharashtra',
    totalCapacity: 600,
    activeBiometricStations: 6,
    totalInvigilators: 18,
    cctvSurveillanceStatus: 'Active',
    bandwidthSpeedMbps: 450,
  },
  {
    centerCode: 'ELT-KA-03',
    centerName: 'ELTNOY High-Tech Testing Center',
    city: 'Bengaluru',
    state: 'Karnataka',
    totalCapacity: 850,
    activeBiometricStations: 10,
    totalInvigilators: 28,
    cctvSurveillanceStatus: 'Active',
    bandwidthSpeedMbps: 1000,
  },
];

export const INITIAL_SLOTS: ExamSlot[] = [
  {
    id: 'slot-1',
    examCode: 'ENT-2025',
    examName: 'ELTNOY National Test 2025 (Morning Shift)',
    shiftName: 'Shift 1',
    timeRange: '09:00 AM - 12:00 PM',
    totalAllocatedSeats: 500,
    checkedInCount: 432,
    status: 'Live CBT Session',
    labRooms: [
      { roomName: 'Lab Alpha (Hall 1)', capacity: 150, occupied: 142, proctorAssigned: 'Prof. Ramesh Gupta' },
      { roomName: 'Lab Beta (Hall 2)', capacity: 150, occupied: 138, proctorAssigned: 'Dr. Sunita Rao' },
      { roomName: 'Lab Gamma (Hall 3)', capacity: 200, occupied: 152, proctorAssigned: 'Er. Vivek Nair' },
    ],
  },
  {
    id: 'slot-2',
    examCode: 'ENT-2025',
    examName: 'ELTNOY National Test 2025 (Afternoon Shift)',
    shiftName: 'Shift 2',
    timeRange: '02:00 PM - 05:00 PM',
    totalAllocatedSeats: 500,
    checkedInCount: 0,
    status: 'Scheduled',
    labRooms: [
      { roomName: 'Lab Alpha (Hall 1)', capacity: 150, occupied: 0, proctorAssigned: 'Prof. Ananya Sen' },
      { roomName: 'Lab Beta (Hall 2)', capacity: 150, occupied: 0, proctorAssigned: 'Dr. S. K. Mittal' },
      { roomName: 'Lab Gamma (Hall 3)', capacity: 200, occupied: 0, proctorAssigned: 'Prof. Priya Mehta' },
    ],
  },
];

export const INITIAL_BIOMETRIC_RECORDS: BiometricRecord[] = [
  {
    id: 'bio-001',
    rollNumber: 'ENT-2025-9981',
    candidateName: 'Aarav Sharma',
    deskStation: 'Biometric Station 01',
    fingerprintMatchPercent: 99.4,
    photoMatchPercent: 98.8,
    checkInTimestamp: '08:14 AM',
    status: 'Verified & Admitted',
    labRoom: 'Lab Alpha',
    seatNumber: 'A-014',
  },
  {
    id: 'bio-002',
    rollNumber: 'ENT-2025-4420',
    candidateName: 'Priya Patel',
    deskStation: 'Biometric Station 02',
    fingerprintMatchPercent: 98.2,
    photoMatchPercent: 99.1,
    checkInTimestamp: '08:22 AM',
    status: 'Verified & Admitted',
    labRoom: 'Lab Alpha',
    seatNumber: 'A-028',
  },
  {
    id: 'bio-003',
    rollNumber: 'ENT-2025-8812',
    candidateName: 'Vikram Singh',
    deskStation: 'Biometric Station 03',
    fingerprintMatchPercent: 64.2,
    photoMatchPercent: 71.0,
    checkInTimestamp: '08:35 AM',
    status: 'Biometric Mismatch Flag',
    labRoom: 'Special Verification Desk',
    seatNumber: 'FLAGGED',
  },
  {
    id: 'bio-004',
    rollNumber: 'ENT-2025-3391',
    candidateName: 'Kavita Menon',
    deskStation: 'Biometric Station 04',
    fingerprintMatchPercent: 97.9,
    photoMatchPercent: 98.5,
    checkInTimestamp: '08:41 AM',
    status: 'Verified & Admitted',
    labRoom: 'Lab Beta',
    seatNumber: 'B-042',
  },
  {
    id: 'bio-005',
    rollNumber: 'ENT-2025-7721',
    candidateName: 'Mohammed Tariq',
    deskStation: 'Biometric Station 02',
    fingerprintMatchPercent: 0,
    photoMatchPercent: 0,
    checkInTimestamp: 'Awaiting Check-in',
    status: 'Pending Verification',
    labRoom: 'Lab Beta',
    seatNumber: 'B-099',
  },
];

export const INITIAL_PROCTORS: ProctorAssignment[] = [
  {
    id: 'proc-01',
    staffName: 'Dr. Ramesh Gupta',
    staffId: 'ELT-STF-019',
    role: 'Chief Superintendent',
    assignedRoom: 'Control Center & Lab Alpha',
    dutyStatus: 'On Duty',
    contactNumber: '+91-98110-XXXXX',
    activeTerminalCount: 150,
  },
  {
    id: 'proc-02',
    staffName: 'Dr. Sunita Rao',
    staffId: 'ELT-STF-042',
    role: 'Lab Invigilator',
    assignedRoom: 'Lab Beta (Hall 2)',
    dutyStatus: 'On Duty',
    contactNumber: '+91-98221-XXXXX',
    activeTerminalCount: 150,
  },
  {
    id: 'proc-03',
    staffName: 'Er. Vivek Nair',
    staffId: 'ELT-STF-088',
    role: 'IT Systems Admin',
    assignedRoom: 'Server Room & Lab Gamma',
    dutyStatus: 'On Duty',
    contactNumber: '+91-98334-XXXXX',
    activeTerminalCount: 200,
  },
  {
    id: 'proc-04',
    staffName: 'Anita Desai',
    staffId: 'ELT-STF-102',
    role: 'Biometric Desk Officer',
    assignedRoom: 'Entrance Gate Biometric Stations 1-4',
    dutyStatus: 'On Duty',
    contactNumber: '+91-98445-XXXXX',
    activeTerminalCount: 4,
  },
];

export function calculateInstituteOverview(
  center: InstituteCenterProfile,
  slots: ExamSlot[],
  biometrics: BiometricRecord[]
) {
  const activeSlot = slots.find((s) => s.status === 'Live CBT Session') || slots[0];
  const totalAllocated = activeSlot ? activeSlot.totalAllocatedSeats : center.totalCapacity;
  const verifiedCount = biometrics.filter((b) => b.status === 'Verified & Admitted').length;
  const flaggedCount = biometrics.filter((b) => b.status === 'Biometric Mismatch Flag').length;
  const pendingCount = biometrics.filter((b) => b.status === 'Pending Verification').length;

  const attendanceRate = totalAllocated > 0 ? Number(((verifiedCount / totalAllocated) * 100).toFixed(1)) : 0;

  return {
    activeSlot,
    totalAllocated,
    verifiedCount,
    flaggedCount,
    pendingCount,
    attendanceRate,
    invigilatorsOnDuty: INITIAL_PROCTORS.filter((p) => p.dutyStatus === 'On Duty').length,
  };
}

export function filterBiometrics(
  records: BiometricRecord[],
  filter: 'ALL' | 'VERIFIED' | 'PENDING' | 'FLAGGED',
  query: string = ''
): BiometricRecord[] {
  const q = query.trim().toLowerCase();
  return records.filter((rec) => {
    const matchesFilter =
      filter === 'ALL'
        ? true
        : filter === 'VERIFIED'
        ? rec.status === 'Verified & Admitted'
        : filter === 'PENDING'
        ? rec.status === 'Pending Verification'
        : rec.status === 'Biometric Mismatch Flag';

    if (!matchesFilter) return false;
    if (!q) return true;

    return (
      rec.rollNumber.toLowerCase().includes(q) ||
      rec.candidateName.toLowerCase().includes(q) ||
      rec.deskStation.toLowerCase().includes(q) ||
      rec.labRoom.toLowerCase().includes(q)
    );
  });
}

export function updateBiometricRecordStatus(
  records: BiometricRecord[],
  id: string,
  newStatus: BiometricRecord['status'],
  assignedSeat?: string
): BiometricRecord[] {
  return records.map((rec) => {
    if (rec.id === id) {
      return {
        ...rec,
        status: newStatus,
        seatNumber: assignedSeat || (newStatus === 'Verified & Admitted' ? 'A-MANUAL' : rec.seatNumber),
        fingerprintMatchPercent: newStatus === 'Verified & Admitted' && rec.fingerprintMatchPercent < 80 ? 95.0 : rec.fingerprintMatchPercent,
        photoMatchPercent: newStatus === 'Verified & Admitted' && rec.photoMatchPercent < 80 ? 96.0 : rec.photoMatchPercent,
      };
    }
    return rec;
  });
}
