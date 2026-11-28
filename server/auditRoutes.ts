// A-12: the audit-log viewer. Super Admin only; no route here writes, edits or deletes events.
//
// - GET /api/admin/audit-events: newest first, keyset pagination on (occurred_at, id), allow-listed
//   filters, a required date window (default 7 days, at most 93) and at most 100 rows per page.
// - Actor names are looked up at read time from `users` (never stored in audit rows).
// - Every search writes exactly one `audit.searched` event with the filter NAMES and the result
//   count (never the rows), before the rows are sent. If that record cannot be written, nothing is
//   sent (fail closed). Reading never triggers further reads, so there is no recursion.
// - Institutions get no read access: an organization activity view conflicts with A-12 (C-03) and
//   needs a client decision first.
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { auditActor, AUDIT_CONTRACTS, recordAuditEvent, runAuditedTransaction } from './audit.js';
import { requireAuth, requireRoles, requireSuperAdmin } from './auth.js';
import { pool as sharedPool } from './db.js';

export const AUDIT_EVENTS_PATH = '/api/admin/audit-events';
export const AUDIT_PAGE_SIZE_MAX = 100;
export const AUDIT_WINDOW_DEFAULT_DAYS = 7;
export const AUDIT_WINDOW_MAX_DAYS = 93;
const DAY_MS = 24 * 60 * 60 * 1000;

const CATEGORIES = [...new Set(Object.values(AUDIT_CONTRACTS).map((contract) => contract.category))].sort() as [string, ...string[]];
const ACTIONS = Object.keys(AUDIT_CONTRACTS).sort() as [string, ...string[]];
const id = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);

export const auditQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  category: z.enum(CATEGORIES).optional(),
  action: z.enum(ACTIONS).optional(),
  outcome: z.enum(['succeeded', 'denied', 'failed']).optional(),
  actorUserId: id.optional(),
  organizationId: id.optional(),
  resourceType: z.string().trim().regex(/^[a-z][a-z0-9_]{0,63}$/).optional(),
  resourceId: id.optional(),
  limit: z.coerce.number().int().min(1).max(AUDIT_PAGE_SIZE_MAX).default(50),
  /** Opaque cursor from the previous page: "<occurred_at ISO>|<uuid>". */
  cursor: z.string().regex(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z\|[0-9a-f-]{36}$/).optional(),
}).strict();

export type AuditQuery = z.infer<typeof auditQuerySchema>;

/** Builds the parameterised viewer query. Exported for tests. */
export function buildAuditQuery(query: AuditQuery, now: Date) {
  const to = query.to ? new Date(query.to) : now;
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - AUDIT_WINDOW_DEFAULT_DAYS * DAY_MS);
  if (!(from < to)) return { error: 'The start of the date range must be before its end.' } as const;
  if (to.getTime() - from.getTime() > AUDIT_WINDOW_MAX_DAYS * DAY_MS) {
    return { error: `Choose a date range of at most ${AUDIT_WINDOW_MAX_DAYS} days.` } as const;
  }
  const where = ['e.occurred_at >= $1', 'e.occurred_at < $2'];
  const values: unknown[] = [from.toISOString(), to.toISOString()];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    where.push(sql.replace('?', `$${values.length}`));
  };
  if (query.category) add('e.category = ?', query.category);
  if (query.action) add('e.action = ?', query.action);
  if (query.outcome) add('e.outcome = ?', query.outcome);
  if (query.actorUserId) add('e.actor_user_id = ?', query.actorUserId);
  if (query.organizationId) add('e.organization_id = ?', query.organizationId);
  if (query.resourceType) add('e.resource_type = ?', query.resourceType);
  if (query.resourceId) add('e.resource_id = ?', query.resourceId);
  if (query.cursor) {
    const [at, eventId] = query.cursor.split('|');
    values.push(at, eventId);
    where.push(`(e.occurred_at, e.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
  }
  values.push(query.limit + 1);
  // occurred_at_cursor keeps microseconds (a JavaScript Date would round to milliseconds and skip rows).
  const text = `SELECT e.id, e.occurred_at,
         to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at_cursor, e.category, e.action, e.outcome, e.reason_code, e.actor_type,
         e.actor_user_id, e.actor_role, e.organization_id, e.resource_type, e.resource_id, e.metadata,
         actor.display_name AS actor_name, actor.login_id AS actor_login_id, org.display_name AS organization_name
    FROM audit_events e
    LEFT JOIN users actor ON actor.id = e.actor_user_id
    LEFT JOIN users org ON org.id = e.organization_id
   WHERE ${where.join(' AND ')}
   ORDER BY e.occurred_at DESC, e.id DESC
   LIMIT $${values.length}`;
  return { text, values, from, to } as const;
}

function toView(row: Record<string, unknown>) {
  const occurredAt = new Date(String(row.occurred_at));
  return {
    id: String(row.id),
    occurredAt: occurredAt.toISOString(),
    category: row.category,
    action: row.action,
    outcome: row.outcome,
    reasonCode: row.reason_code ?? null,
    actor: {
      type: row.actor_type,
      userId: row.actor_user_id ?? null,
      role: row.actor_role ?? null,
      // Looked up now; "unknown account" when the account no longer exists.
      name: row.actor_user_id ? (row.actor_name ?? null) : null,
      loginId: row.actor_user_id ? (row.actor_login_id ?? null) : null,
    },
    organization: row.organization_id ? { id: row.organization_id, name: row.organization_name ?? null } : null,
    resource: { type: row.resource_type, id: row.resource_id ?? null },
    metadata: row.metadata ?? {},
  };
}

export function createAuditRouter(options: { database?: Pick<Pool, 'query' | 'connect'>; now?: () => Date } = {}): Router {
  const database = options.database ?? sharedPool;
  const now = options.now ?? (() => new Date());
  const router = express.Router();

  router.get('/admin/audit-events', requireAuth, requireRoles('official'), requireSuperAdmin, (request: Request, response: Response, next: NextFunction) => {
    (async () => {
      response.set('Cache-Control', 'no-store');
      const parsed = auditQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        response.status(400).json({ error: 'Invalid audit search.', details: parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })) });
        return;
      }
      const built = buildAuditQuery(parsed.data, now());
      if ('error' in built) {
        response.status(400).json({ error: built.error });
        return;
      }
      const { rows } = await database.query(built.text, built.values);
      const page = rows.slice(0, parsed.data.limit);
      const last = page.at(-1);
      const filterKeys = Object.keys(parsed.data).filter((key) => key !== 'limit' && key !== 'cursor').sort();
      // Record the search before sending anything (fail closed).
      await runAuditedTransaction(database, (client) => recordAuditEvent(client, {
        action: 'audit.searched', actor: auditActor(request), metadata: { result_count: page.length, filter_keys: filterKeys },
      }));
      response.json({
        events: page.map(toView),
        range: { from: built.from.toISOString(), to: built.to.toISOString() },
        nextCursor: rows.length > parsed.data.limit && last
          ? `${String(last.occurred_at_cursor)}|${String(last.id)}`
          : null,
        filters: { categories: CATEGORIES, actions: ACTIONS },
      });
    })().catch(next);
  });

  return router;
}
