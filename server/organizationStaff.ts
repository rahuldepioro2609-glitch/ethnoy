// SM-1: Organization Staff — an identity system independent of users and of Platform Staff,
// managed by the Organization Owner (center account) under Q115–Q117.
//
// Implemented (approved by Q115–Q117 and Option A):
// - Owner invites a member; the invitation code is random, single-use, expiring, stored only as a
//   SHA-256 hash and bound to one organization (Q116). Codes expire after the approved fixed period
//   of 72 hours (SM2-P01); the period is policy, not deployment configuration.
// - The invitee accepts with the code and chooses a password (no session is created).
// - Mobile OTP verification is UNAVAILABLE (C-18: no approved SMS provider). No fake or hardcoded
//   OTP exists, so verified_at is never set and no member can become active.
// - Super Admin activation (Q115) requires a recorded verification, so it currently refuses.
// - Owner assigns the six Q117 role templates; members never change roles (escalation guard).
// - Organization Staff sign-in, separate session table and path-scoped cookie, per-request
//   authorization, session-derived organization identity, append-only audit events.
//
// NOT implemented (policy not decided): custom roles and permissions (D-08), suspension and removal
// (who may do it: Q115 gap), invitation revocation, staff work modules, owner audit view (C-03).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { hashSessionToken, newSessionToken, requireAuth, requireRoles, requireSuperAdmin, type AuthenticatedRequest } from './auth.js';
import {
  BCRYPT_COST,
  clearScopedSessionCookie,
  compareAgainstDummyHash,
  createStaffAuthLimiter,
  displayNameSchema,
  isPlausibleToken,
  isUndefinedTableError,
  isUniqueViolation,
  readCookie,
  sendValidationError,
  setScopedSessionCookie,
  STAFF_SESSION_TTL_MS,
  staffIdSchema,
  staffPasswordSchema,
  staffRoute,
  StaffConflictError,
  StaffNotFoundError,
  StaffStoreUnavailableError,
} from './staffCommon.js';

export const ORG_STAFF_COOKIE = 'elt_org_staff';
export const ORG_STAFF_API_PATH = '/api/org-staff';
export const ORG_STAFF_OWNER_PATH = '/api/center/staff';
export const ORG_STAFF_ADMIN_PATH = '/api/admin/organization-staff';
export const ORG_STAFF_ROLE_CODES = ['reviewer', 'verifier', 'application_manager', 'finance_viewer', 'invigilator', 'viewer'] as const;
export type OrgStaffRoleCode = (typeof ORG_STAFF_ROLE_CODES)[number];

export const ORG_STAFF_OTP_UNAVAILABLE =
  'Mobile OTP verification is not available: no SMS provider has been approved (C-18). Organization Staff accounts cannot be verified or activated until it is.';
/** Approved invitation-code lifetime (SM2-P01, Q116 "expiring"). Fixed by policy; no environment override. */
export const ORG_STAFF_INVITATION_TTL_HOURS = 72;
export const ORG_STAFF_INVITATION_TTL_MS = ORG_STAFF_INVITATION_TTL_HOURS * 60 * 60 * 1000;
export const ORG_STAFF_WORK_QUEUE_UNAVAILABLE =
  'No organization work modules are available to staff yet: the permission catalogue (D-08) and the application and examination-session modules (PERM-01/Q118, D-09/C-20) are not approved or built.';
export const ORG_STAFF_ACTIVITY_UNAVAILABLE =
  'Activity history is not available: staff-visible and owner-visible activity views are awaiting a decision (C-03, A-12).';
export const GENERIC_ORG_STAFF_LOGIN_FAILURE = 'Invalid organization ID, staff ID or password.';
export const GENERIC_INVITATION_FAILURE = 'The invitation is invalid, already used or expired.';

export type OrgStaffStatus = 'invited' | 'active' | 'suspended' | 'removed';

export interface OrgStaffMemberView {
  id: string;
  staffId: string;
  displayName: string;
  status: OrgStaffStatus;
  accepted: boolean;
  verified: boolean;
  roles: OrgStaffRoleCode[];
  invitation: { state: 'live' | 'expired' | 'used' | 'none'; expiresAt: string | null };
  createdAt: string;
}

export interface OrgStaffSessionView {
  memberId: string;
  organizationId: string;
  organizationName: string;
  staffId: string;
  displayName: string;
  roles: OrgStaffRoleCode[];
}

export interface OrgStaffActivationView {
  id: string;
  organizationName: string;
  organizationLoginId: string;
  staffId: string;
  displayName: string;
  status: OrgStaffStatus;
  accepted: boolean;
  verified: boolean;
  createdAt: string;
}

export interface OrgStaffStore {
  listRoleTemplates(): Promise<Array<{ code: OrgStaffRoleCode; label: string; description: string }>>;
  listMembers(organizationId: string, now: Date): Promise<OrgStaffMemberView[]>;
  createInvitation(organizationId: string, input: { staffId: string; displayName: string; codeHash: string; expiresAt: Date }, ownerId: string): Promise<OrgStaffMemberView>;
  setMemberRoles(organizationId: string, memberId: string, roleCodes: OrgStaffRoleCode[], ownerId: string): Promise<OrgStaffMemberView>;
  /** Consumes a live invitation and stores the password. Returns false for any invalid case. */
  acceptInvitation(input: { organizationLoginId: string; staffId: string; codeHash: string; passwordHash: string; now: Date }): Promise<boolean>;
  findLoginRecord(organizationLoginId: string, staffId: string): Promise<{ memberId: string; organizationId: string; passwordHash: string | null; status: OrgStaffStatus; organizationApproved: boolean } | null>;
  startSession(memberId: string, organizationId: string, tokenHash: string, expiresAt: Date): Promise<void>;
  recordLoginFailure(organizationId: string | null, memberId: string | null): Promise<void>;
  /** Active session of an ACTIVE member of an APPROVED organization, or null. */
  loadSession(tokenHash: string, now: Date): Promise<OrgStaffSessionView | null>;
  endSession(tokenHash: string, memberId: string, organizationId: string): Promise<void>;
  listForActivation(): Promise<OrgStaffActivationView[]>;
  /** Q115: Super Admin activation; only an accepted AND verified invited member can be activated. */
  activateMember(memberId: string, superAdminId: string): Promise<'activated' | 'not_verified' | 'not_invited' | 'not_found'>;
}

// ---------------------------------------------------------------------------
// PostgreSQL store
// ---------------------------------------------------------------------------

interface QueryablePool {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
  connect(): Promise<PoolClient>;
}

const MEMBER_VIEW_SQL = `
  SELECT m.id, m.staff_id, m.display_name, m.status, m.accepted_at, m.verified_at, m.created_at,
         COALESCE((SELECT json_agg(mr.role_code ORDER BY mr.role_code) FROM org_staff_member_roles mr
                   WHERE mr.member_id = m.id AND mr.organization_id = m.organization_id AND mr.revoked_at IS NULL), '[]'::json) AS roles,
         i.expires_at AS invitation_expires_at, i.used_at AS invitation_used_at
  FROM org_staff_members m
  LEFT JOIN LATERAL (SELECT expires_at, used_at FROM org_staff_invitations inv
                     WHERE inv.member_id = m.id AND inv.organization_id = m.organization_id
                     ORDER BY inv.created_at DESC LIMIT 1) i ON true`;

function toMemberView(row: Record<string, unknown>, now: Date): OrgStaffMemberView {
  const expires = row.invitation_expires_at ? new Date(String(row.invitation_expires_at)) : null;
  const state: OrgStaffMemberView['invitation']['state'] = row.invitation_used_at ? 'used' : !expires ? 'none' : expires > now ? 'live' : 'expired';
  return {
    id: String(row.id),
    staffId: String(row.staff_id),
    displayName: String(row.display_name),
    status: row.status as OrgStaffStatus,
    accepted: Boolean(row.accepted_at),
    verified: Boolean(row.verified_at),
    roles: (Array.isArray(row.roles) ? row.roles : []) as OrgStaffRoleCode[],
    invitation: { state, expiresAt: expires ? expires.toISOString() : null },
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

export function createPostgresOrgStaffStore(pool: QueryablePool): OrgStaffStore {
  async function run<T>(work: (db: QueryablePool) => Promise<T>): Promise<T> {
    try {
      return await work(pool);
    } catch (error) {
      if (isUndefinedTableError(error)) throw new StaffStoreUnavailableError();
      throw error;
    }
  }
  async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (isUndefinedTableError(error)) throw new StaffStoreUnavailableError();
      if (isUniqueViolation(error)) throw new StaffConflictError('That Staff ID is already used in this organization.');
      throw error;
    } finally {
      client.release();
    }
  }
  const audit = (client: PoolClient, event: { organizationId: string; actorKind: 'organization_owner' | 'org_staff' | 'super_admin' | 'anonymous'; actorId: string | null; action: string; targetMemberId: string | null; details?: Record<string, unknown> }) => client.query(
    `INSERT INTO org_staff_audit_events (id, organization_id, actor_kind, actor_id, action, target_member_id, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [randomUUID(), event.organizationId, event.actorKind, event.actorId, event.action, event.targetMemberId, JSON.stringify(event.details ?? {})],
  );
  const memberInOrg = async (db: QueryablePool | PoolClient, organizationId: string, memberId: string, now: Date) => {
    const { rows } = await db.query(`${MEMBER_VIEW_SQL} WHERE m.id = $1 AND m.organization_id = $2`, [memberId, organizationId]);
    if (!rows[0]) throw new StaffNotFoundError('Staff member not found in your organization.');
    return toMemberView(rows[0], now);
  };

  return {
    listRoleTemplates: () => run(async (db) => (await db.query('SELECT code, label, description FROM org_staff_role_templates ORDER BY label')).rows
      .map((row) => ({ code: row.code as OrgStaffRoleCode, label: String(row.label), description: String(row.description) }))),
    listMembers: (organizationId, now) => run(async (db) => (await db.query(`${MEMBER_VIEW_SQL} WHERE m.organization_id = $1 ORDER BY m.created_at DESC LIMIT 500`, [organizationId]))
      .rows.map((row) => toMemberView(row, now))),
    createInvitation: (organizationId, input, ownerId) => transaction(async (client) => {
      const memberId = randomUUID();
      await client.query(
        `INSERT INTO org_staff_members (id, organization_id, staff_id, display_name, invited_by) VALUES ($1, $2, $3, $4, $5)`,
        [memberId, organizationId, input.staffId, input.displayName, ownerId],
      );
      await client.query(
        `INSERT INTO org_staff_invitations (id, member_id, organization_id, code_hash, expires_at) VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), memberId, organizationId, input.codeHash, input.expiresAt],
      );
      await audit(client, { organizationId, actorKind: 'organization_owner', actorId: ownerId, action: 'member.invited', targetMemberId: memberId, details: { staffId: input.staffId, expiresAt: input.expiresAt.toISOString() } });
      return memberInOrg(client, organizationId, memberId, new Date());
    }),
    setMemberRoles: (organizationId, memberId, roleCodes, ownerId) => transaction(async (client) => {
      const before = await memberInOrg(client, organizationId, memberId, new Date());
      if (before.status === 'removed') throw new StaffConflictError('Roles cannot be assigned to a removed member.');
      await client.query('SELECT id FROM org_staff_members WHERE id = $1 AND organization_id = $2 FOR UPDATE', [memberId, organizationId]);
      // Removed roles are revoked, never deleted (grant history is kept; the API role has no DELETE).
      await client.query(
        'UPDATE org_staff_member_roles SET revoked_at = now(), revoked_by = $4 WHERE member_id = $1 AND organization_id = $2 AND revoked_at IS NULL AND NOT (role_code = ANY($3::text[]))',
        [memberId, organizationId, roleCodes, ownerId],
      );
      for (const code of roleCodes) {
        await client.query(
          `INSERT INTO org_staff_member_roles (id, member_id, organization_id, role_code, granted_by) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (member_id, role_code) WHERE revoked_at IS NULL DO NOTHING`,
          [randomUUID(), memberId, organizationId, code, ownerId],
        );
      }
      const after = await memberInOrg(client, organizationId, memberId, new Date());
      await audit(client, { organizationId, actorKind: 'organization_owner', actorId: ownerId, action: 'member.roles_changed', targetMemberId: memberId, details: { before: before.roles, after: after.roles } });
      return after;
    }),
    acceptInvitation: (input) => transaction(async (client) => {
      const { rows } = await client.query(
        `SELECT i.id AS invitation_id, m.id AS member_id, m.organization_id
         FROM org_staff_invitations i
         JOIN org_staff_members m ON m.id = i.member_id AND m.organization_id = i.organization_id
         JOIN users o ON o.id = m.organization_id
         WHERE i.code_hash = $1 AND i.used_at IS NULL AND i.expires_at > $2
           AND m.staff_id = $3 AND m.status = 'invited' AND m.password_hash IS NULL
           AND o.login_id = $4 AND o.role = 'center' AND o.account_status = 'approved'
         FOR UPDATE OF i, m`,
        [input.codeHash, input.now, input.staffId, input.organizationLoginId],
      );
      if (!rows[0]) return false;
      await client.query('UPDATE org_staff_invitations SET used_at = $2 WHERE id = $1', [rows[0].invitation_id, input.now]);
      await client.query('UPDATE org_staff_members SET password_hash = $2, accepted_at = $3 WHERE id = $1', [rows[0].member_id, input.passwordHash, input.now]);
      await audit(client, { organizationId: String(rows[0].organization_id), actorKind: 'anonymous', actorId: null, action: 'member.invitation_accepted', targetMemberId: String(rows[0].member_id) });
      return true;
    }),
    findLoginRecord: (organizationLoginId, staffId) => run(async (db) => {
      const { rows } = await db.query(
        `SELECT m.id, m.organization_id, m.password_hash, m.status, (o.account_status = 'approved') AS organization_approved
         FROM org_staff_members m JOIN users o ON o.id = m.organization_id
         WHERE o.login_id = $1 AND o.role = 'center' AND m.staff_id = $2`,
        [organizationLoginId, staffId],
      );
      return rows[0] ? {
        memberId: String(rows[0].id), organizationId: String(rows[0].organization_id),
        passwordHash: rows[0].password_hash === null ? null : String(rows[0].password_hash),
        status: rows[0].status as OrgStaffStatus, organizationApproved: rows[0].organization_approved === true,
      } : null;
    }),
    startSession: (memberId, organizationId, tokenHash, expiresAt) => transaction(async (client) => {
      await client.query('INSERT INTO org_staff_sessions (token_hash, member_id, organization_id, expires_at) VALUES ($1, $2, $3, $4)', [tokenHash, memberId, organizationId, expiresAt]);
      await audit(client, { organizationId, actorKind: 'org_staff', actorId: memberId, action: 'auth.login_succeeded', targetMemberId: memberId });
    }),
    recordLoginFailure: (organizationId, memberId) => (organizationId
      ? transaction(async (client) => { await audit(client, { organizationId, actorKind: 'anonymous', actorId: null, action: 'auth.login_failed', targetMemberId: memberId }); })
      : Promise.resolve()),
    loadSession: (tokenHash, now) => run(async (db) => {
      const { rows } = await db.query(
        `SELECT m.id, m.organization_id, m.staff_id, m.display_name, o.display_name AS organization_name,
                COALESCE((SELECT json_agg(mr.role_code ORDER BY mr.role_code) FROM org_staff_member_roles mr
                          WHERE mr.member_id = m.id AND mr.organization_id = m.organization_id AND mr.revoked_at IS NULL), '[]'::json) AS roles
         FROM org_staff_sessions s
         JOIN org_staff_members m ON m.id = s.member_id AND m.organization_id = s.organization_id
         JOIN users o ON o.id = m.organization_id
         WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2
           AND m.status = 'active' AND o.role = 'center' AND o.account_status = 'approved'`,
        [tokenHash, now],
      );
      return rows[0] ? {
        memberId: String(rows[0].id), organizationId: String(rows[0].organization_id), organizationName: String(rows[0].organization_name),
        staffId: String(rows[0].staff_id), displayName: String(rows[0].display_name), roles: rows[0].roles as OrgStaffRoleCode[],
      } : null;
    }),
    endSession: (tokenHash, memberId, organizationId) => transaction(async (client) => {
      await client.query('UPDATE org_staff_sessions SET revoked_at = now() WHERE token_hash = $1 AND member_id = $2 AND organization_id = $3 AND revoked_at IS NULL', [tokenHash, memberId, organizationId]);
      await audit(client, { organizationId, actorKind: 'org_staff', actorId: memberId, action: 'auth.logout', targetMemberId: memberId });
    }),
    listForActivation: () => run(async (db) => (await db.query(
      `SELECT m.id, o.display_name AS organization_name, o.login_id AS organization_login_id, m.staff_id, m.display_name,
              m.status, m.accepted_at, m.verified_at, m.created_at
       FROM org_staff_members m JOIN users o ON o.id = m.organization_id
       WHERE m.status = 'invited' ORDER BY m.created_at DESC LIMIT 500`,
    )).rows.map((row) => ({
      id: String(row.id), organizationName: String(row.organization_name), organizationLoginId: String(row.organization_login_id),
      staffId: String(row.staff_id), displayName: String(row.display_name), status: row.status as OrgStaffStatus,
      accepted: Boolean(row.accepted_at), verified: Boolean(row.verified_at), createdAt: new Date(String(row.created_at)).toISOString(),
    }))),
    activateMember: (memberId, superAdminId) => transaction(async (client) => {
      const { rows } = await client.query('SELECT organization_id, status, accepted_at, verified_at FROM org_staff_members WHERE id = $1 FOR UPDATE', [memberId]);
      if (!rows[0]) return 'not_found';
      const organizationId = String(rows[0].organization_id);
      if (rows[0].status !== 'invited') return 'not_invited';
      if (!rows[0].accepted_at || !rows[0].verified_at) {
        await audit(client, { organizationId, actorKind: 'super_admin', actorId: superAdminId, action: 'member.activation_refused', targetMemberId: memberId, details: { reason: 'not_verified' } });
        return 'not_verified';
      }
      await client.query("UPDATE org_staff_members SET status = 'active', activated_at = now(), activated_by = $2 WHERE id = $1", [memberId, superAdminId]);
      await audit(client, { organizationId, actorKind: 'super_admin', actorId: superAdminId, action: 'member.activated', targetMemberId: memberId });
      return 'activated';
    }),
  };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export function hashInvitationCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

// ---------------------------------------------------------------------------
// Routers
// ---------------------------------------------------------------------------

interface OrgStaffRequest extends Request {
  orgStaff?: OrgStaffSessionView;
  orgStaffTokenHash?: string;
}

export interface OrgStaffRouterOptions {
  store: OrgStaffStore;
  now?: () => Date;
  sessionTtlMs?: number;
}

const ADMIN_GUARDS = [requireAuth, requireRoles('official'), requireSuperAdmin] as const;
const OWNER_GUARDS = [requireAuth, requireRoles('center')] as const;
const roleCodeSchema = z.enum(ORG_STAFF_ROLE_CODES);
const organizationLoginIdSchema = z.string().trim().min(4).max(50).regex(/^[A-Za-z0-9._-]+$/).transform((value) => value.toUpperCase());

export function createOrgStaffRouters(options: OrgStaffRouterOptions): { ownerRouter: Router; staffRouter: Router; adminRouter: Router } {
  const { store } = options;
  const now = options.now ?? (() => new Date());
  const ttl = options.sessionTtlMs ?? STAFF_SESSION_TTL_MS;
  const authLimiter = createStaffAuthLimiter();
  const acceptLimiter = createStaffAuthLimiter();
  const ownerId = (request: Request) => (request as AuthenticatedRequest).user!.id;

  // --- Organization Owner (center session; organization = the Owner's own account) ---
  const ownerRouter = express.Router();

  ownerRouter.get('/center/staff', ...OWNER_GUARDS, staffRoute(async (request, response) => {
    response.set('Cache-Control', 'no-store');
    response.json({
      members: await store.listMembers(ownerId(request), now()),
      roleTemplates: await store.listRoleTemplates(),
      invitationsAvailable: true,
      invitationsUnavailableReason: null,
      invitationExpiryHours: ORG_STAFF_INVITATION_TTL_HOURS,
      verification: { available: false, reason: ORG_STAFF_OTP_UNAVAILABLE },
      customRoles: { available: false, reason: 'Custom roles need the permission catalogue (D-08).' },
      suspensionAndRemoval: { available: false, reason: 'Who may suspend or remove Organization Staff is not decided (Q115).' },
    });
  }));

  ownerRouter.post('/center/staff/invitations', ...OWNER_GUARDS, staffRoute(async (request, response) => {
    const parsed = z.object({ staffId: staffIdSchema, displayName: displayNameSchema }).strict().safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    const code = randomBytes(32).toString('base64url');
    const member = await store.createInvitation(ownerId(request), {
      staffId: parsed.data.staffId,
      displayName: parsed.data.displayName,
      codeHash: hashInvitationCode(code),
      expiresAt: new Date(now().getTime() + ORG_STAFF_INVITATION_TTL_MS),
    }, ownerId(request));
    response.set('Cache-Control', 'no-store');
    // The code is returned exactly once, to the Owner who created it; only its hash is stored.
    response.status(201).json({ member, invitationCode: code });
  }));

  ownerRouter.put('/center/staff/:id/roles', ...OWNER_GUARDS, staffRoute(async (request, response) => {
    const parsed = z.object({
      roleCodes: z.array(roleCodeSchema).max(ORG_STAFF_ROLE_CODES.length).refine((codes) => new Set(codes).size === codes.length, 'Duplicate role.'),
    }).strict().safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    response.json({ member: await store.setMemberRoles(ownerId(request), String(request.params.id), parsed.data.roleCodes, ownerId(request)) });
  }));

  // --- Organization Staff (own session; Institution surface) ---
  async function authenticate(request: OrgStaffRequest, response: Response): Promise<boolean> {
    const token = readCookie(request, ORG_STAFF_COOKIE);
    if (!isPlausibleToken(token)) {
      response.status(401).json({ error: 'Organization staff sign-in is required.' });
      return false;
    }
    const tokenHash = hashSessionToken(token);
    const session = await store.loadSession(tokenHash, now());
    if (!session) {
      clearScopedSessionCookie(response, ORG_STAFF_COOKIE, ORG_STAFF_API_PATH);
      response.status(401).json({ error: 'Your staff session has ended. Please sign in again.' });
      return false;
    }
    request.orgStaff = session;
    request.orgStaffTokenHash = tokenHash;
    return true;
  }
  function requireOrgStaff(request: Request, response: Response, next: NextFunction): void {
    authenticate(request as OrgStaffRequest, response).then((ok) => { if (ok) next(); }, next);
  }

  const staffRouter = express.Router();

  staffRouter.post('/org-staff/invitations/accept', acceptLimiter, staffRoute(async (request, response) => {
    const parsed = z.object({
      organizationLoginId: organizationLoginIdSchema,
      staffId: staffIdSchema,
      invitationCode: z.string().regex(/^[A-Za-z0-9_-]{40,64}$/),
      password: staffPasswordSchema,
    }).strict().safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: GENERIC_INVITATION_FAILURE });
      return;
    }
    const accepted = await store.acceptInvitation({
      organizationLoginId: parsed.data.organizationLoginId,
      staffId: parsed.data.staffId,
      codeHash: hashInvitationCode(parsed.data.invitationCode),
      passwordHash: await bcrypt.hash(parsed.data.password, BCRYPT_COST),
      now: now(),
    });
    if (!accepted) {
      response.status(400).json({ error: GENERIC_INVITATION_FAILURE });
      return;
    }
    response.status(200).json({
      message: 'Invitation accepted. Your account still needs mobile verification and Super Admin activation before you can sign in.',
      verification: { available: false, reason: ORG_STAFF_OTP_UNAVAILABLE },
    });
  }));

  // C-18: no SMS provider is approved. There is deliberately no fake, fixed or bypass code.
  staffRouter.post('/org-staff/verification/otp', (_request, response) => {
    response.status(503).json({ error: ORG_STAFF_OTP_UNAVAILABLE, code: 'OTP_UNAVAILABLE' });
  });

  staffRouter.post('/org-staff/auth/login', authLimiter, staffRoute(async (request, response) => {
    const parsed = z.object({ organizationLoginId: organizationLoginIdSchema, staffId: staffIdSchema, password: z.string().min(1).max(128) }).safeParse(request.body);
    if (!parsed.success) {
      response.status(401).json({ error: GENERIC_ORG_STAFF_LOGIN_FAILURE });
      return;
    }
    const record = await store.findLoginRecord(parsed.data.organizationLoginId, parsed.data.staffId);
    const eligible = record !== null && record.status === 'active' && record.organizationApproved && record.passwordHash !== null;
    const valid = eligible
      ? await bcrypt.compare(parsed.data.password, record!.passwordHash!)
      : await compareAgainstDummyHash(parsed.data.password);
    if (!eligible || !valid) {
      await store.recordLoginFailure(record?.organizationId ?? null, record?.memberId ?? null);
      response.status(401).json({ error: GENERIC_ORG_STAFF_LOGIN_FAILURE });
      return;
    }
    const token = newSessionToken();
    await store.startSession(record!.memberId, record!.organizationId, hashSessionToken(token), new Date(now().getTime() + ttl));
    setScopedSessionCookie(response, ORG_STAFF_COOKIE, ORG_STAFF_API_PATH, token, ttl);
    const session = await store.loadSession(hashSessionToken(token), now());
    response.json({ staff: session ? { staffId: session.staffId, displayName: session.displayName, organizationName: session.organizationName, roles: session.roles } : null });
  }));

  staffRouter.get('/org-staff/auth/me', requireOrgStaff, staffRoute(async (request, response) => {
    const session = (request as OrgStaffRequest).orgStaff!;
    response.set('Cache-Control', 'no-store');
    response.json({ staff: { staffId: session.staffId, displayName: session.displayName, organizationName: session.organizationName, roles: session.roles } });
  }));

  staffRouter.post('/org-staff/auth/logout', requireOrgStaff, staffRoute(async (request, response) => {
    const staffRequest = request as OrgStaffRequest;
    await store.endSession(staffRequest.orgStaffTokenHash!, staffRequest.orgStaff!.memberId, staffRequest.orgStaff!.organizationId);
    clearScopedSessionCookie(response, ORG_STAFF_COOKIE, ORG_STAFF_API_PATH);
    response.status(204).end();
  }));

  staffRouter.get('/org-staff/dashboard', requireOrgStaff, staffRoute(async (request, response) => {
    const session = (request as OrgStaffRequest).orgStaff!;
    response.set('Cache-Control', 'no-store');
    response.json({
      organization: { name: session.organizationName },
      staff: { staffId: session.staffId, displayName: session.displayName, roles: session.roles },
      workQueue: { available: false, reason: ORG_STAFF_WORK_QUEUE_UNAVAILABLE, items: [] },
      activity: { available: false, reason: ORG_STAFF_ACTIVITY_UNAVAILABLE, events: [] },
    });
  }));

  // --- Super Admin (Q115 activation) ---
  const adminRouter = express.Router();

  adminRouter.get('/admin/organization-staff', ...ADMIN_GUARDS, staffRoute(async (_request, response) => {
    response.set('Cache-Control', 'no-store');
    response.json({ members: await store.listForActivation(), verification: { available: false, reason: ORG_STAFF_OTP_UNAVAILABLE } });
  }));

  adminRouter.post('/admin/organization-staff/:id/activate', ...ADMIN_GUARDS, staffRoute(async (request, response) => {
    const result = await store.activateMember(String(request.params.id), (request as AuthenticatedRequest).user!.id);
    if (result === 'activated') {
      response.json({ status: 'active' });
      return;
    }
    if (result === 'not_found') {
      response.status(404).json({ error: 'Organization staff member not found.' });
      return;
    }
    response.status(409).json({
      error: result === 'not_verified'
        ? 'This member has not completed identity verification (Q116). Activation is refused; mobile OTP is unavailable (C-18).'
        : 'Only an invited member awaiting activation can be activated.',
      code: result === 'not_verified' ? 'NOT_VERIFIED' : 'NOT_AWAITING_ACTIVATION',
    });
  }));

  return { ownerRouter, staffRouter, adminRouter };
}
