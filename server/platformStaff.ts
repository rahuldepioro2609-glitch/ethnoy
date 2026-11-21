// SM-1: Platform Staff — an identity system independent of users and of Organization Staff,
// managed exclusively by the Super Admin (approved Option A).
//
// Implemented (approved): Super Admin-only creation and deactivation; Staff ID + password sign-in on
// the Admin surface; a separate session table and a path-scoped cookie; department and role
// assignment; per-request authorization; append-only audit events; no self-service of permissions.
//
// Deliberately NOT implemented (policy not decided; see the SM-1 report):
// - granting permissions: the catalogue is empty until D-08 is approved, so roles carry none;
// - work modules for staff (A-01, A-08, A-17, D-08): the work queue reports itself unavailable;
// - staff reading their own activity history (A-12: audit reads are Super Admin only);
// - reactivation, per-account lockout, one-device sessions, IP/device logging, MFA (SEC-07).
import { randomUUID } from 'node:crypto';
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
  GENERIC_STAFF_LOGIN_FAILURE,
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

export const PLATFORM_STAFF_COOKIE = 'elt_platform_staff';
export const PLATFORM_STAFF_API_PATH = '/api/platform-staff';
export const PLATFORM_STAFF_ADMIN_PATH = '/api/admin/platform-staff';

export const PLATFORM_STAFF_WORK_QUEUE_UNAVAILABLE =
  'No work modules are delegated to Platform Staff yet. Delegation needs the permission catalogue (D-08) and the module decisions A-01, A-08 and A-17.';
export const PLATFORM_STAFF_ACTIVITY_UNAVAILABLE =
  'Activity history for staff is not available: reading audit records is limited to Super Admins (A-12) until a staff-visible activity view is approved.';

export type PlatformStaffStatus = 'active' | 'deactivated';

export interface PlatformStaffAccountView {
  id: string;
  staffId: string;
  displayName: string;
  status: PlatformStaffStatus;
  mustChangePassword: boolean;
  department: { id: string; name: string } | null;
  roles: Array<{ id: string; name: string }>;
  permissions: string[];
  createdAt: string;
  deactivatedAt: string | null;
}

export interface PlatformStaffLoginRecord {
  id: string;
  passwordHash: string;
  status: PlatformStaffStatus;
}

export interface PlatformStaffAuditEvent {
  id: string;
  occurredAt: string;
  actorKind: 'super_admin' | 'platform_staff' | 'anonymous';
  actorId: string | null;
  action: string;
  targetAccountId: string | null;
  details: Record<string, unknown>;
}

export interface PlatformStaffStore {
  findLoginRecord(staffId: string): Promise<PlatformStaffLoginRecord | null>;
  startSession(accountId: string, tokenHash: string, expiresAt: Date): Promise<void>;
  recordLoginFailure(accountId: string | null, reason: 'unknown_or_inactive' | 'wrong_password'): Promise<void>;
  /** Active, unexpired, unrevoked session of an ACTIVE account, or null. */
  loadSession(tokenHash: string, now: Date): Promise<PlatformStaffAccountView | null>;
  endSession(tokenHash: string, accountId: string): Promise<void>;
  changePassword(accountId: string, newPasswordHash: string, keepTokenHash: string): Promise<void>;
  getPasswordHash(accountId: string): Promise<string | null>;
  listAccounts(): Promise<PlatformStaffAccountView[]>;
  createAccount(input: { staffId: string; displayName: string; passwordHash: string; departmentId: string | null }, actorId: string): Promise<PlatformStaffAccountView>;
  deactivateAccount(accountId: string, actorId: string, reason: string): Promise<PlatformStaffAccountView>;
  setAssignment(accountId: string, input: { departmentId: string | null; roleIds: string[] }, actorId: string): Promise<PlatformStaffAccountView>;
  listDepartments(): Promise<Array<{ id: string; name: string; createdAt: string }>>;
  createDepartment(name: string, actorId: string): Promise<{ id: string; name: string; createdAt: string }>;
  listRoles(): Promise<Array<{ id: string; name: string; description: string; permissions: string[]; createdAt: string }>>;
  createRole(name: string, description: string, actorId: string): Promise<{ id: string; name: string; description: string; permissions: string[]; createdAt: string }>;
  listPermissionCatalogue(): Promise<Array<{ code: string; module: string; description: string }>>;
  listAuditEvents(limit: number): Promise<PlatformStaffAuditEvent[]>;
}

// ---------------------------------------------------------------------------
// PostgreSQL store (one transaction per operation; audit rows in the same transaction)
// ---------------------------------------------------------------------------

interface QueryablePool {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
  connect(): Promise<PoolClient>;
}

const ACCOUNT_VIEW_SQL = `
  SELECT a.id, a.staff_id, a.display_name, a.status, a.must_change_password, a.created_at, a.deactivated_at,
         d.id AS department_id, d.name AS department_name,
         COALESCE((SELECT json_agg(json_build_object('id', r.id, 'name', r.name) ORDER BY r.name)
                   FROM platform_staff_account_roles ar JOIN platform_staff_roles r ON r.id = ar.role_id
                   WHERE ar.account_id = a.id AND ar.revoked_at IS NULL), '[]'::json) AS roles,
         COALESCE((SELECT json_agg(DISTINCT rp.permission_code)
                   FROM platform_staff_account_roles ar
                   JOIN platform_staff_role_permissions rp ON rp.role_id = ar.role_id
                   JOIN platform_staff_permission_catalogue c ON c.code = rp.permission_code
                   WHERE ar.account_id = a.id AND ar.revoked_at IS NULL), '[]'::json) AS permissions
  FROM platform_staff_accounts a
  LEFT JOIN platform_staff_departments d ON d.id = a.department_id`;

function toAccountView(row: Record<string, unknown>): PlatformStaffAccountView {
  const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : value === null || value === undefined ? null : String(value));
  return {
    id: String(row.id),
    staffId: String(row.staff_id),
    displayName: String(row.display_name),
    status: row.status === 'active' ? 'active' : 'deactivated',
    mustChangePassword: row.must_change_password === true,
    department: row.department_id ? { id: String(row.department_id), name: String(row.department_name) } : null,
    roles: Array.isArray(row.roles) ? (row.roles as Array<{ id: string; name: string }>) : [],
    permissions: Array.isArray(row.permissions) ? (row.permissions as string[]).sort() : [],
    createdAt: iso(row.created_at) ?? '',
    deactivatedAt: iso(row.deactivated_at),
  };
}

export function createPostgresPlatformStaffStore(pool: QueryablePool): PlatformStaffStore {
  async function run<T>(work: (client: QueryablePool | PoolClient) => Promise<T>): Promise<T> {
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
      if (isUniqueViolation(error)) throw new StaffConflictError('That name or Staff ID is already in use.');
      throw error;
    } finally {
      client.release();
    }
  }
  const audit = (client: PoolClient, event: Omit<PlatformStaffAuditEvent, 'id' | 'occurredAt'>) => client.query(
    `INSERT INTO platform_staff_audit_events (id, actor_kind, actor_id, action, target_account_id, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [randomUUID(), event.actorKind, event.actorId, event.action, event.targetAccountId, JSON.stringify(event.details)],
  );
  const viewById = async (client: QueryablePool | PoolClient, id: string) => {
    const { rows } = await client.query(`${ACCOUNT_VIEW_SQL} WHERE a.id = $1`, [id]);
    if (!rows[0]) throw new StaffNotFoundError('Platform staff account not found.');
    return toAccountView(rows[0]);
  };

  return {
    findLoginRecord: (staffId) => run(async (db) => {
      const { rows } = await db.query('SELECT id, password_hash, status FROM platform_staff_accounts WHERE staff_id = $1', [staffId]);
      return rows[0] ? { id: String(rows[0].id), passwordHash: String(rows[0].password_hash), status: rows[0].status === 'active' ? 'active' : 'deactivated' } : null;
    }),
    startSession: (accountId, tokenHash, expiresAt) => transaction(async (client) => {
      await client.query('INSERT INTO platform_staff_sessions (token_hash, account_id, expires_at) VALUES ($1, $2, $3)', [tokenHash, accountId, expiresAt]);
      await audit(client, { actorKind: 'platform_staff', actorId: accountId, action: 'auth.login_succeeded', targetAccountId: accountId, details: {} });
    }),
    recordLoginFailure: (accountId, reason) => transaction(async (client) => {
      await audit(client, { actorKind: 'anonymous', actorId: null, action: 'auth.login_failed', targetAccountId: accountId, details: { reason } });
    }),
    loadSession: (tokenHash, now) => run(async (db) => {
      const { rows } = await db.query(
        `${ACCOUNT_VIEW_SQL}
         JOIN platform_staff_sessions s ON s.account_id = a.id
         WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2 AND a.status = 'active'`,
        [tokenHash, now],
      );
      return rows[0] ? toAccountView(rows[0]) : null;
    }),
    endSession: (tokenHash, accountId) => transaction(async (client) => {
      await client.query('UPDATE platform_staff_sessions SET revoked_at = now() WHERE token_hash = $1 AND account_id = $2 AND revoked_at IS NULL', [tokenHash, accountId]);
      await audit(client, { actorKind: 'platform_staff', actorId: accountId, action: 'auth.logout', targetAccountId: accountId, details: {} });
    }),
    getPasswordHash: (accountId) => run(async (db) => {
      const { rows } = await db.query("SELECT password_hash FROM platform_staff_accounts WHERE id = $1 AND status = 'active'", [accountId]);
      return rows[0] ? String(rows[0].password_hash) : null;
    }),
    changePassword: (accountId, newPasswordHash, keepTokenHash) => transaction(async (client) => {
      const { rowCount } = await client.query(
        "UPDATE platform_staff_accounts SET password_hash = $2, must_change_password = false WHERE id = $1 AND status = 'active'",
        [accountId, newPasswordHash],
      );
      if (rowCount !== 1) throw new StaffNotFoundError('Platform staff account not found.');
      // Other sessions of this account end; the session that changed the password continues.
      const revoked = await client.query(
        'UPDATE platform_staff_sessions SET revoked_at = now() WHERE account_id = $1 AND token_hash <> $2 AND revoked_at IS NULL',
        [accountId, keepTokenHash],
      );
      await audit(client, { actorKind: 'platform_staff', actorId: accountId, action: 'auth.password_changed', targetAccountId: accountId, details: { otherSessionsEnded: revoked.rowCount ?? 0 } });
    }),
    listAccounts: () => run(async (db) => (await db.query(`${ACCOUNT_VIEW_SQL} ORDER BY a.created_at DESC LIMIT 500`)).rows.map(toAccountView)),
    createAccount: (input, actorId) => transaction(async (client) => {
      if (input.departmentId) {
        const { rows } = await client.query('SELECT id FROM platform_staff_departments WHERE id = $1', [input.departmentId]);
        if (!rows[0]) throw new StaffNotFoundError('Department not found.');
      }
      const id = randomUUID();
      await client.query(
        `INSERT INTO platform_staff_accounts (id, staff_id, display_name, password_hash, department_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, input.staffId, input.displayName, input.passwordHash, input.departmentId, actorId],
      );
      await audit(client, { actorKind: 'super_admin', actorId, action: 'staff.created', targetAccountId: id, details: { staffId: input.staffId, departmentId: input.departmentId } });
      return viewById(client, id);
    }),
    deactivateAccount: (accountId, actorId, reason) => transaction(async (client) => {
      const { rows } = await client.query('SELECT status FROM platform_staff_accounts WHERE id = $1 FOR UPDATE', [accountId]);
      if (!rows[0]) throw new StaffNotFoundError('Platform staff account not found.');
      if (rows[0].status !== 'active') throw new StaffConflictError('This account is already deactivated.');
      await client.query(
        "UPDATE platform_staff_accounts SET status = 'deactivated', deactivated_at = now(), deactivated_by = $2 WHERE id = $1",
        [accountId, actorId],
      );
      const revoked = await client.query('UPDATE platform_staff_sessions SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL', [accountId]);
      await audit(client, { actorKind: 'super_admin', actorId, action: 'staff.deactivated', targetAccountId: accountId, details: { reason, sessionsEnded: revoked.rowCount ?? 0 } });
      return viewById(client, accountId);
    }),
    setAssignment: (accountId, input, actorId) => transaction(async (client) => {
      const before = await viewById(client, accountId);
      if (before.status !== 'active') throw new StaffConflictError('A deactivated account cannot be assigned.');
      await client.query('SELECT id FROM platform_staff_accounts WHERE id = $1 FOR UPDATE', [accountId]);
      if (input.departmentId) {
        const { rows } = await client.query('SELECT id FROM platform_staff_departments WHERE id = $1', [input.departmentId]);
        if (!rows[0]) throw new StaffNotFoundError('Department not found.');
      }
      if (input.roleIds.length > 0) {
        const { rows } = await client.query('SELECT id FROM platform_staff_roles WHERE id = ANY($1::text[])', [input.roleIds]);
        if (rows.length !== input.roleIds.length) throw new StaffNotFoundError('One or more roles were not found.');
      }
      await client.query('UPDATE platform_staff_accounts SET department_id = $2 WHERE id = $1', [accountId, input.departmentId]);
      // Removed roles are revoked, never deleted (grant history is kept; the API role has no DELETE).
      await client.query(
        'UPDATE platform_staff_account_roles SET revoked_at = now(), revoked_by = $3 WHERE account_id = $1 AND revoked_at IS NULL AND NOT (role_id = ANY($2::text[]))',
        [accountId, input.roleIds, actorId],
      );
      for (const roleId of input.roleIds) {
        await client.query(
          `INSERT INTO platform_staff_account_roles (id, account_id, role_id, granted_by) VALUES ($1, $2, $3, $4)
           ON CONFLICT (account_id, role_id) WHERE revoked_at IS NULL DO NOTHING`,
          [randomUUID(), accountId, roleId, actorId],
        );
      }
      const after = await viewById(client, accountId);
      await audit(client, {
        actorKind: 'super_admin', actorId, action: 'staff.assignment_changed', targetAccountId: accountId,
        details: { before: { departmentId: before.department?.id ?? null, roleIds: before.roles.map((r) => r.id) }, after: { departmentId: after.department?.id ?? null, roleIds: after.roles.map((r) => r.id) } },
      });
      return after;
    }),
    listDepartments: () => run(async (db) => (await db.query('SELECT id, name, created_at FROM platform_staff_departments ORDER BY name')).rows
      .map((row) => ({ id: String(row.id), name: String(row.name), createdAt: new Date(String(row.created_at)).toISOString() }))),
    createDepartment: (name, actorId) => transaction(async (client) => {
      const id = randomUUID();
      const { rows } = await client.query('INSERT INTO platform_staff_departments (id, name, created_by) VALUES ($1, $2, $3) RETURNING created_at', [id, name, actorId]);
      await audit(client, { actorKind: 'super_admin', actorId, action: 'department.created', targetAccountId: null, details: { departmentId: id, name } });
      return { id, name, createdAt: new Date(String(rows[0].created_at)).toISOString() };
    }),
    listRoles: () => run(async (db) => (await db.query(
      `SELECT r.id, r.name, r.description, r.created_at,
              COALESCE((SELECT json_agg(rp.permission_code ORDER BY rp.permission_code) FROM platform_staff_role_permissions rp WHERE rp.role_id = r.id), '[]'::json) AS permissions
       FROM platform_staff_roles r ORDER BY r.name`,
    )).rows.map((row) => ({ id: String(row.id), name: String(row.name), description: String(row.description), permissions: row.permissions as string[], createdAt: new Date(String(row.created_at)).toISOString() }))),
    createRole: (name, description, actorId) => transaction(async (client) => {
      const id = randomUUID();
      const { rows } = await client.query('INSERT INTO platform_staff_roles (id, name, description, created_by) VALUES ($1, $2, $3, $4) RETURNING created_at', [id, name, description, actorId]);
      await audit(client, { actorKind: 'super_admin', actorId, action: 'role.created', targetAccountId: null, details: { roleId: id, name } });
      return { id, name, description, permissions: [], createdAt: new Date(String(rows[0].created_at)).toISOString() };
    }),
    listPermissionCatalogue: () => run(async (db) => (await db.query('SELECT code, module, description FROM platform_staff_permission_catalogue ORDER BY code')).rows
      .map((row) => ({ code: String(row.code), module: String(row.module), description: String(row.description) }))),
    listAuditEvents: (limit) => run(async (db) => (await db.query(
      'SELECT id, occurred_at, actor_kind, actor_id, action, target_account_id, details FROM platform_staff_audit_events ORDER BY occurred_at DESC LIMIT $1',
      [limit],
    )).rows.map((row) => ({
      id: String(row.id), occurredAt: new Date(String(row.occurred_at)).toISOString(), actorKind: row.actor_kind as PlatformStaffAuditEvent['actorKind'],
      actorId: row.actor_id === null ? null : String(row.actor_id), action: String(row.action),
      targetAccountId: row.target_account_id === null ? null : String(row.target_account_id), details: (row.details ?? {}) as Record<string, unknown>,
    }))),
  };
}

// ---------------------------------------------------------------------------
// Routers
// ---------------------------------------------------------------------------

interface PlatformStaffRequest extends Request {
  platformStaff?: PlatformStaffAccountView;
  platformStaffTokenHash?: string;
}

export interface PlatformStaffRouterOptions {
  store: PlatformStaffStore;
  now?: () => Date;
  sessionTtlMs?: number;
}

const ADMIN_GUARDS = [requireAuth, requireRoles('official'), requireSuperAdmin] as const;

function publicAccountView(account: PlatformStaffAccountView) {
  return {
    staffId: account.staffId,
    displayName: account.displayName,
    mustChangePassword: account.mustChangePassword,
    department: account.department,
    roles: account.roles,
    permissions: account.permissions,
  };
}

export function createPlatformStaffRouters(options: PlatformStaffRouterOptions): { staffRouter: Router; adminRouter: Router } {
  const { store } = options;
  const now = options.now ?? (() => new Date());
  const ttl = options.sessionTtlMs ?? STAFF_SESSION_TTL_MS;
  const loginLimiter = createStaffAuthLimiter();

  async function authenticate(request: PlatformStaffRequest, response: Response): Promise<boolean> {
    const token = readCookie(request, PLATFORM_STAFF_COOKIE);
    if (!isPlausibleToken(token)) {
      response.status(401).json({ error: 'Platform staff sign-in is required.' });
      return false;
    }
    const tokenHash = hashSessionToken(token);
    const account = await store.loadSession(tokenHash, now());
    if (!account) {
      clearScopedSessionCookie(response, PLATFORM_STAFF_COOKIE, PLATFORM_STAFF_API_PATH);
      response.status(401).json({ error: 'Your staff session has ended. Please sign in again.' });
      return false;
    }
    request.platformStaff = account;
    request.platformStaffTokenHash = tokenHash;
    return true;
  }

  /** Any signed-in, active Platform Staff account, including one that must still change its password. */
  function requirePlatformStaffSession(request: Request, response: Response, next: NextFunction): void {
    authenticate(request as PlatformStaffRequest, response).then((ok) => { if (ok) next(); }, next);
  }
  /** A signed-in, active Platform Staff account that has replaced its initial password. */
  function requirePlatformStaff(request: Request, response: Response, next: NextFunction): void {
    authenticate(request as PlatformStaffRequest, response).then((ok) => {
      if (!ok) return;
      if ((request as PlatformStaffRequest).platformStaff?.mustChangePassword) {
        response.status(403).json({ error: 'Change your initial password before continuing.', code: 'PASSWORD_CHANGE_REQUIRED' });
        return;
      }
      next();
    }, next);
  }

  const staffRouter = express.Router();

  staffRouter.post('/platform-staff/auth/login', loginLimiter, staffRoute(async (request, response) => {
    const parsed = z.object({ staffId: staffIdSchema, password: z.string().min(1).max(128) }).safeParse(request.body);
    if (!parsed.success) {
      response.status(401).json({ error: GENERIC_STAFF_LOGIN_FAILURE });
      return;
    }
    const record = await store.findLoginRecord(parsed.data.staffId);
    const valid = record && record.status === 'active'
      ? await bcrypt.compare(parsed.data.password, record.passwordHash)
      : await compareAgainstDummyHash(parsed.data.password);
    if (!record || record.status !== 'active' || !valid) {
      await store.recordLoginFailure(record && record.status === 'active' ? record.id : null, record && record.status === 'active' ? 'wrong_password' : 'unknown_or_inactive');
      response.status(401).json({ error: GENERIC_STAFF_LOGIN_FAILURE });
      return;
    }
    const token = newSessionToken();
    await store.startSession(record.id, hashSessionToken(token), new Date(now().getTime() + ttl));
    setScopedSessionCookie(response, PLATFORM_STAFF_COOKIE, PLATFORM_STAFF_API_PATH, token, ttl);
    const account = await store.loadSession(hashSessionToken(token), now());
    response.json({ staff: account ? publicAccountView(account) : null });
  }));

  staffRouter.get('/platform-staff/auth/me', requirePlatformStaffSession, staffRoute(async (request, response) => {
    response.set('Cache-Control', 'no-store');
    response.json({ staff: publicAccountView((request as PlatformStaffRequest).platformStaff!) });
  }));

  staffRouter.post('/platform-staff/auth/logout', requirePlatformStaffSession, staffRoute(async (request, response) => {
    const staffRequest = request as PlatformStaffRequest;
    await store.endSession(staffRequest.platformStaffTokenHash!, staffRequest.platformStaff!.id);
    clearScopedSessionCookie(response, PLATFORM_STAFF_COOKIE, PLATFORM_STAFF_API_PATH);
    response.status(204).end();
  }));

  staffRouter.post('/platform-staff/auth/password', requirePlatformStaffSession, staffRoute(async (request, response) => {
    const parsed = z.object({ currentPassword: z.string().min(1).max(128), newPassword: staffPasswordSchema }).safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    if (parsed.data.currentPassword === parsed.data.newPassword) {
      response.status(400).json({ error: 'The new password must differ from the current password.' });
      return;
    }
    const staffRequest = request as PlatformStaffRequest;
    const currentHash = await store.getPasswordHash(staffRequest.platformStaff!.id);
    if (!currentHash || !(await bcrypt.compare(parsed.data.currentPassword, currentHash))) {
      response.status(403).json({ error: 'The current password is incorrect.' });
      return;
    }
    await store.changePassword(staffRequest.platformStaff!.id, await bcrypt.hash(parsed.data.newPassword, BCRYPT_COST), staffRequest.platformStaffTokenHash!);
    response.status(204).end();
  }));

  staffRouter.get('/platform-staff/dashboard', requirePlatformStaff, staffRoute(async (request, response) => {
    const account = (request as PlatformStaffRequest).platformStaff!;
    response.set('Cache-Control', 'no-store');
    response.json({
      staff: publicAccountView(account),
      workQueue: { available: false, reason: PLATFORM_STAFF_WORK_QUEUE_UNAVAILABLE, items: [] },
      activity: { available: false, reason: PLATFORM_STAFF_ACTIVITY_UNAVAILABLE, events: [] },
    });
  }));

  const adminRouter = express.Router();
  const actor = (request: Request) => (request as AuthenticatedRequest).user!.id;

  adminRouter.get('/admin/platform-staff', ...ADMIN_GUARDS, staffRoute(async (_request, response) => {
    response.json({ accounts: await store.listAccounts() });
  }));

  adminRouter.post('/admin/platform-staff', ...ADMIN_GUARDS, staffRoute(async (request, response) => {
    const parsed = z.object({
      staffId: staffIdSchema,
      displayName: displayNameSchema,
      initialPassword: staffPasswordSchema,
      departmentId: z.string().min(1).max(64).nullable().optional(),
    }).strict().safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    const account = await store.createAccount({
      staffId: parsed.data.staffId,
      displayName: parsed.data.displayName,
      passwordHash: await bcrypt.hash(parsed.data.initialPassword, BCRYPT_COST),
      departmentId: parsed.data.departmentId ?? null,
    }, actor(request));
    response.status(201).json({ account });
  }));

  adminRouter.post('/admin/platform-staff/:id/deactivate', ...ADMIN_GUARDS, staffRoute(async (request, response) => {
    const parsed = z.object({ reason: z.string().trim().min(10).max(500) }).strict().safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    response.json({ account: await store.deactivateAccount(String(request.params.id), actor(request), parsed.data.reason) });
  }));

  adminRouter.put('/admin/platform-staff/:id/assignment', ...ADMIN_GUARDS, staffRoute(async (request, response) => {
    const parsed = z.object({
      departmentId: z.string().min(1).max(64).nullable(),
      roleIds: z.array(z.string().min(1).max(64)).max(20).refine((ids) => new Set(ids).size === ids.length, 'Duplicate role.'),
    }).strict().safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    response.json({ account: await store.setAssignment(String(request.params.id), parsed.data, actor(request)) });
  }));

  adminRouter.get('/admin/platform-staff/departments', ...ADMIN_GUARDS, staffRoute(async (_request, response) => {
    response.json({ departments: await store.listDepartments() });
  }));

  adminRouter.post('/admin/platform-staff/departments', ...ADMIN_GUARDS, staffRoute(async (request, response) => {
    const parsed = z.object({ name: displayNameSchema }).strict().safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    response.status(201).json({ department: await store.createDepartment(parsed.data.name, actor(request)) });
  }));

  adminRouter.get('/admin/platform-staff/roles', ...ADMIN_GUARDS, staffRoute(async (_request, response) => {
    response.json({ roles: await store.listRoles(), permissionCatalogue: await store.listPermissionCatalogue() });
  }));

  // Roles are named groupings only. Permissions cannot be attached through the API: the catalogue is
  // empty until D-08 is approved, and any "permissions" field is rejected (strict schema).
  adminRouter.post('/admin/platform-staff/roles', ...ADMIN_GUARDS, staffRoute(async (request, response) => {
    const parsed = z.object({ name: displayNameSchema, description: z.string().trim().max(500).optional() }).strict().safeParse(request.body);
    if (!parsed.success) {
      sendValidationError(response, parsed.error);
      return;
    }
    response.status(201).json({ role: await store.createRole(parsed.data.name, parsed.data.description ?? '', actor(request)) });
  }));

  adminRouter.get('/admin/platform-staff/audit', ...ADMIN_GUARDS, staffRoute(async (_request, response) => {
    response.set('Cache-Control', 'no-store');
    response.json({ events: await store.listAuditEvents(200) });
  }));

  return { staffRouter, adminRouter };
}
