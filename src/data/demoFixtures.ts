// Client-facing dashboard showcase (/demo): SYNTHETIC fixtures only. Every name, ID, number and date
// below is invented for the preview and is clearly labelled as sample data. Nothing here is a real
// account, person, institute, credential or record, and nothing is ever sent to the server.

export const DEMO_LABEL = 'Sample data';

export const demoStudent = {
  name: 'Sample Student (Demo)',
  id: 'DEMO-STUDENT',
  stats: { applications: 2, mockTests: 3, publishedResults: 1 },
  applications: [
    { number: 'DEMO-APP-0001', exam: 'Sample National Aptitude Test', code: 'DEMO-NAT', status: 'Approved', admitCard: 'Published (sample)' },
    { number: 'DEMO-APP-0002', exam: 'Sample Scholarship Test', code: 'DEMO-SCH', status: 'Under review', admitCard: 'Not published' },
  ],
  results: { count: 1 },
  practice: [
    { id: 'p1', correct: 3, total: 4, percentage: 75 },
    { id: 'p2', correct: 2, total: 4, percentage: 50 },
    { id: 'p3', correct: 4, total: 4, percentage: 100 },
  ],
  onlineExams: [
    { code: 'DEMO-NAT', name: 'Sample National Aptitude Test', questions: 40, minutes: 60, status: 'Available: you can start this exam once.', tone: 'text-emerald-800' },
    { code: 'DEMO-SCH', name: 'Sample Scholarship Test', questions: 30, minutes: 45, status: 'Submitted · Score 24 / 30 (sample)', tone: 'text-slate-600' },
  ],
};

export const demoInstitute = {
  name: 'Sample Institute of Learning (Demo)',
  id: 'DEMO-CENTER-01',
  stats: { checkins: 3 },
  checkins: [
    { id: 'c1', application: 'DEMO-APP-0101', candidate: 'Sample Candidate A', status: 'Identity verified' },
    { id: 'c2', application: 'DEMO-APP-0102', candidate: 'Sample Candidate B', status: 'Identity verified' },
    { id: 'c3', application: 'DEMO-APP-0103', candidate: 'Sample Candidate C', status: 'Absent' },
  ],
  forms: [
    { id: 'f1', title: 'Sample Teacher Recruitment 2026', kind: 'Teacher recruitment', status: 'approved' },
    { id: 'f2', title: 'Sample Entrance Form 2026', kind: 'Exam application', status: 'pending' },
  ],
  wallet: { available: '₹ 12,500 (sample)', reserved: '₹ 2,000 (sample)' },
  staff: [
    { id: 's1', name: 'Sample Reviewer', staffId: 'DEMO-STAFF-01', role: 'Reviewer', status: 'Invited' },
    { id: 's2', name: 'Sample Verifier', staffId: 'DEMO-STAFF-02', role: 'Verifier', status: 'Invited' },
  ],
};
