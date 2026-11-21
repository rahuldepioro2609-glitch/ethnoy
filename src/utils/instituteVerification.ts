// AUTH-1 / SM-2 (frontend): which institutional decisions to offer for an Institute. Display only:
// the server re-checks every transition and answers 409 when one does not apply.
export type InstitutionalDecision = 'verify' | 'reject' | 'suspend' | 'restore';

export function availableDecisions(row: { institutionalVerification: 'pending' | 'verified' | 'rejected'; suspended: boolean }): InstitutionalDecision[] {
  const decisions: InstitutionalDecision[] = [];
  if (row.institutionalVerification !== 'verified') decisions.push('verify');
  if (row.institutionalVerification !== 'rejected') decisions.push('reject');
  decisions.push(row.suspended ? 'restore' : 'suspend');
  return decisions;
}
