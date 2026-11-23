// AUTH-1 / SM-2: Super Admin-only institutional verification and suspension of Institutes.
//
// - Institutional verification (details and documents) is SEPARATE from Official approval
//   (users.account_status): nothing here reads it for a decision or ever changes it.
// - Decisions use the existing institute_verifications columns (institutional_status,
//   institutional_decided_at/by, suspended_at/by) and append one auth_verification_events row per
//   decision with actor, target, action and reason (append-only by trigger).
// - A suspended or not institutionally verified Institute is refused on every request by
//   portalVerificationGate (server/auth.ts); no session handling is needed here.
// - Fails closed: when the AUTH-1 tables are not installed every route answers 503
//   VERIFICATION_NOT_INSTALLED and nothing is written.
import express, { type Request, type RequestHandler, type Response, type Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRoles, requireSuperAdmin, type AuthenticatedRequest } from './auth.js';
import { authVerificationStore, sendFlowError } from './authVerification.js';
import type { InstitutionalAction, InstituteVerificationOverview, InstituteVerificationState } from './authVerificationStore.js';
import { maskEmail, maskMobile } from './verificationProviders.js';

export const INSTITUTE_VERIFICATION_ADMIN_PATH = '/api/admin/institute-verifications';
const ADMIN_GUARDS = [requireAuth, requireRoles('official'), requireSuperAdmin] as const;

const decisionSchema = z.object({ reason: z.string().trim().min(10).max(500) }).strict();
const institutionIdSchema = z.string().min(1).max(64);

const TRANSITION_MESSAGES: Readonly<Record<InstitutionalAction, string>> = Object.freeze({
  verify: 'This institute is already institutionally verified.',
  reject: 'This institute is already institutionally rejected.',
  suspend: 'This institute is already suspended.',
  restore: 'This institute is not suspended.',
});

export function stateView(state: InstituteVerificationState) {
  return {
    institutionalVerification: state.institutionalStatus,
    suspended: state.suspendedAt !== null,
    suspendedAt: state.suspendedAt ? state.suspendedAt.toISOString() : null,
    contacts: {
      mobile: { verified: state.mobileVerifiedAt !== null, destination: state.mobileDestination ? maskMobile(state.mobileDestination) : null },
      email: { verified: state.emailVerifiedAt !== null, destination: state.emailDestination ? maskEmail(state.emailDestination) : null },
    },
  };
}

function overviewView(row: InstituteVerificationOverview) {
  return {
    institutionId: row.institutionId,
    loginId: row.loginId,
    name: row.name,
    officialApproval: row.accountStatus,
    institutionalDecidedAt: row.institutionalDecidedAt ? row.institutionalDecidedAt.toISOString() : null,
    ...stateView(row.state),
  };
}

function route(handler: (request: Request, response: Response) => Promise<void>): RequestHandler {
  return (request, response, next) => {
    handler(request, response).catch((error: unknown) => { if (!sendFlowError(response, error)) next(error); });
  };
}

export function createInstituteVerificationAdminRouter(options: { now?: () => Date } = {}): Router {
  const now = options.now ?? (() => new Date());
  const router = express.Router();

  router.get('/admin/institute-verifications', ...ADMIN_GUARDS, route(async (_request, response) => {
    response.set('Cache-Control', 'no-store');
    response.json({ institutes: (await authVerificationStore().listInstituteVerificationOverview(500)).map(overviewView) });
  }));

  // Super Admin read of the decision audit (A-12: audit reads are Super Admin only).
  router.get('/admin/institute-verifications/decisions', ...ADMIN_GUARDS, route(async (_request, response) => {
    response.set('Cache-Control', 'no-store');
    response.json({
      decisions: (await authVerificationStore().listInstitutionalDecisions(200)).map((event) => ({
        id: event.id, occurredAt: event.occurredAt.toISOString(), action: event.action, institutionId: event.institutionId, actorId: event.actorId, reason: event.reason,
      })),
    });
  }));

  const decide = (action: InstitutionalAction) => route(async (request, response) => {
    const id = institutionIdSchema.safeParse(request.params.institutionId);
    const body = decisionSchema.safeParse(request.body);
    if (!id.success || !body.success) {
      response.status(400).json({ error: 'A reason of 10 to 500 characters is required.', code: 'INVALID_REQUEST' });
      return;
    }
    const result = await authVerificationStore().decideInstitutional({
      institutionId: id.data, actorId: (request as AuthenticatedRequest).user!.id, action, reason: body.data.reason, now: now(),
    });
    if (result.status === 'not_found') {
      response.status(404).json({ error: 'Institute not found.', code: 'INSTITUTE_NOT_FOUND' });
      return;
    }
    if (result.status === 'invalid_transition') {
      response.status(409).json({ error: TRANSITION_MESSAGES[action], code: 'INVALID_TRANSITION', current: stateView(result.state) });
      return;
    }
    response.json({ institutionId: id.data, decision: action, ...stateView(result.state) });
  });

  router.post('/admin/institute-verifications/:institutionId/verify', ...ADMIN_GUARDS, decide('verify'));
  router.post('/admin/institute-verifications/:institutionId/reject', ...ADMIN_GUARDS, decide('reject'));
  router.post('/admin/institute-verifications/:institutionId/suspend', ...ADMIN_GUARDS, decide('suspend'));
  router.post('/admin/institute-verifications/:institutionId/restore', ...ADMIN_GUARDS, decide('restore'));

  return router;
}
