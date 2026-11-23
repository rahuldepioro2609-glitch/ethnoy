// SM-1 test support: in-memory implementations of the two staff stores. They mirror the rules the
// PostgreSQL schema enforces (uniqueness, tenant scoping, "active requires verification",
// append-only audit) so route behaviour can be tested without any database. Used only by tests.
import { randomUUID } from 'node:crypto';
import type { PlatformStaffAccountView, PlatformStaffAuditEvent, PlatformStaffStore } from './platformStaff.js';
import type { OrgStaffActivationView, OrgStaffMemberView, OrgStaffRoleCode, OrgStaffSessionView, OrgStaffStatus, OrgStaffStore } from './organizationStaff.js';
import { StaffConflictError, StaffNotFoundError } from './staffCommon.js';

interface PsAccount {
  id: string; staffId: string; displayName: string; passwordHash: string; status: 'active' | 'deactivated';
  mustChangePassword: boolean; departmentId: string | null; roleIds: string[]; createdAt: Date; deactivatedAt: Date | null;
}

export class MemoryPlatformStaffStore implements PlatformStaffStore {
  accounts = new Map<string, PsAccount>();
  departments = new Map<string, { id: string; name: string; createdAt: Date }>();
  roles = new Map<string, { id: string; name: string; description: string; createdAt: Date }>();
  /** Empty, as in the migration, until D-08 is approved. */
  catalogue: Array<{ code: string; module: string; description: string }> = [];
  rolePermissions = new Map<string, string[]>();
  sessions = new Map<string, { accountId: string; expiresAt: Date; revoked: boolean }>();
  readonly audit: PlatformStaffAuditEvent[] = [];

  private record(event: Omit<PlatformStaffAuditEvent, 'id' | 'occurredAt'>) {
    this.audit.push(Object.freeze({ ...event, details: Object.freeze({ ...event.details }), id: randomUUID(), occurredAt: new Date().toISOString() }));
  }

  private view(account: PsAccount): PlatformStaffAccountView {
    const department = account.departmentId ? this.departments.get(account.departmentId) ?? null : null;
    const catalogueCodes = new Set(this.catalogue.map((entry) => entry.code));
    const permissions = [...new Set(account.roleIds.flatMap((roleId) => this.rolePermissions.get(roleId) ?? []))].filter((code) => catalogueCodes.has(code)).sort();
    return {
      id: account.id, staffId: account.staffId, displayName: account.displayName, status: account.status,
      mustChangePassword: account.mustChangePassword,
      department: department ? { id: department.id, name: department.name } : null,
      roles: account.roleIds.map((id) => ({ id, name: this.roles.get(id)!.name })).sort((a, b) => a.name.localeCompare(b.name)),
      permissions, createdAt: account.createdAt.toISOString(), deactivatedAt: account.deactivatedAt?.toISOString() ?? null,
    };
  }

  private must(accountId: string) {
    const account = this.accounts.get(accountId);
    if (!account) throw new StaffNotFoundError('Platform staff account not found.');
    return account;
  }

  async findLoginRecord(staffId: string) {
    const account = [...this.accounts.values()].find((entry) => entry.staffId === staffId);
    return account ? { id: account.id, passwordHash: account.passwordHash, status: account.status } : null;
  }
  async startSession(accountId: string, tokenHash: string, expiresAt: Date) {
    this.sessions.set(tokenHash, { accountId, expiresAt, revoked: false });
    this.record({ actorKind: 'platform_staff', actorId: accountId, action: 'auth.login_succeeded', targetAccountId: accountId, details: {} });
  }
  async recordLoginFailure(accountId: string | null, reason: 'unknown_or_inactive' | 'wrong_password') {
    this.record({ actorKind: 'anonymous', actorId: null, action: 'auth.login_failed', targetAccountId: accountId, details: { reason } });
  }
  async loadSession(tokenHash: string, now: Date) {
    const session = this.sessions.get(tokenHash);
    if (!session || session.revoked || session.expiresAt <= now) return null;
    const account = this.accounts.get(session.accountId);
    return account && account.status === 'active' ? this.view(account) : null;
  }
  async endSession(tokenHash: string, accountId: string) {
    const session = this.sessions.get(tokenHash);
    if (session && session.accountId === accountId) session.revoked = true;
    this.record({ actorKind: 'platform_staff', actorId: accountId, action: 'auth.logout', targetAccountId: accountId, details: {} });
  }
  async getPasswordHash(accountId: string) {
    const account = this.accounts.get(accountId);
    return account && account.status === 'active' ? account.passwordHash : null;
  }
  async changePassword(accountId: string, newPasswordHash: string, keepTokenHash: string) {
    const account = this.must(accountId);
    account.passwordHash = newPasswordHash;
    account.mustChangePassword = false;
    let ended = 0;
    for (const [hash, session] of this.sessions) {
      if (session.accountId === accountId && hash !== keepTokenHash && !session.revoked) { session.revoked = true; ended += 1; }
    }
    this.record({ actorKind: 'platform_staff', actorId: accountId, action: 'auth.password_changed', targetAccountId: accountId, details: { otherSessionsEnded: ended } });
  }
  async listAccounts() { return [...this.accounts.values()].map((account) => this.view(account)); }
  async createAccount(input: { staffId: string; displayName: string; passwordHash: string; departmentId: string | null }, actorId: string) {
    if ([...this.accounts.values()].some((account) => account.staffId === input.staffId)) throw new StaffConflictError('That name or Staff ID is already in use.');
    if (input.departmentId && !this.departments.has(input.departmentId)) throw new StaffNotFoundError('Department not found.');
    const account: PsAccount = { id: randomUUID(), ...input, status: 'active', mustChangePassword: true, roleIds: [], createdAt: new Date(), deactivatedAt: null };
    this.accounts.set(account.id, account);
    this.record({ actorKind: 'super_admin', actorId, action: 'staff.created', targetAccountId: account.id, details: { staffId: input.staffId, departmentId: input.departmentId } });
    return this.view(account);
  }
  async deactivateAccount(accountId: string, actorId: string, reason: string) {
    const account = this.must(accountId);
    if (account.status !== 'active') throw new StaffConflictError('This account is already deactivated.');
    account.status = 'deactivated';
    account.deactivatedAt = new Date();
    let ended = 0;
    for (const session of this.sessions.values()) if (session.accountId === accountId && !session.revoked) { session.revoked = true; ended += 1; }
    this.record({ actorKind: 'super_admin', actorId, action: 'staff.deactivated', targetAccountId: accountId, details: { reason, sessionsEnded: ended } });
    return this.view(account);
  }
  async setAssignment(accountId: string, input: { departmentId: string | null; roleIds: string[] }, actorId: string) {
    const account = this.must(accountId);
    if (account.status !== 'active') throw new StaffConflictError('A deactivated account cannot be assigned.');
    if (input.departmentId && !this.departments.has(input.departmentId)) throw new StaffNotFoundError('Department not found.');
    if (input.roleIds.some((id) => !this.roles.has(id))) throw new StaffNotFoundError('One or more roles were not found.');
    const before = { departmentId: account.departmentId, roleIds: [...account.roleIds] };
    account.departmentId = input.departmentId;
    account.roleIds = [...input.roleIds];
    this.record({ actorKind: 'super_admin', actorId, action: 'staff.assignment_changed', targetAccountId: accountId, details: { before, after: { departmentId: account.departmentId, roleIds: [...account.roleIds] } } });
    return this.view(account);
  }
  async listDepartments() { return [...this.departments.values()].map((d) => ({ id: d.id, name: d.name, createdAt: d.createdAt.toISOString() })); }
  async createDepartment(name: string, actorId: string) {
    if ([...this.departments.values()].some((d) => d.name.toLowerCase() === name.toLowerCase())) throw new StaffConflictError('That name or Staff ID is already in use.');
    const department = { id: randomUUID(), name, createdAt: new Date() };
    this.departments.set(department.id, department);
    this.record({ actorKind: 'super_admin', actorId, action: 'department.created', targetAccountId: null, details: { departmentId: department.id, name } });
    return { id: department.id, name, createdAt: department.createdAt.toISOString() };
  }
  async listRoles() {
    return [...this.roles.values()].map((r) => ({ id: r.id, name: r.name, description: r.description, permissions: this.rolePermissions.get(r.id) ?? [], createdAt: r.createdAt.toISOString() }));
  }
  async createRole(name: string, description: string, actorId: string) {
    if ([...this.roles.values()].some((r) => r.name.toLowerCase() === name.toLowerCase())) throw new StaffConflictError('That name or Staff ID is already in use.');
    const role = { id: randomUUID(), name, description, createdAt: new Date() };
    this.roles.set(role.id, role);
    this.record({ actorKind: 'super_admin', actorId, action: 'role.created', targetAccountId: null, details: { roleId: role.id, name } });
    return { id: role.id, name, description, permissions: [], createdAt: role.createdAt.toISOString() };
  }
  async listPermissionCatalogue() { return [...this.catalogue]; }
  async listAuditEvents(limit: number) { return [...this.audit].reverse().slice(0, limit); }
}

interface OrgMember {
  id: string; organizationId: string; staffId: string; displayName: string; passwordHash: string | null; status: OrgStaffStatus;
  acceptedAt: Date | null; verifiedAt: Date | null; activatedBy: string | null; roles: OrgStaffRoleCode[]; createdAt: Date;
}

export interface MemoryOrganization { id: string; loginId: string; name: string; approved: boolean }

export class MemoryOrgStaffStore implements OrgStaffStore {
  organizations = new Map<string, MemoryOrganization>();
  members = new Map<string, OrgMember>();
  invitations: Array<{ memberId: string; organizationId: string; codeHash: string; expiresAt: Date; usedAt: Date | null; createdAt: Date }> = [];
  sessions = new Map<string, { memberId: string; organizationId: string; expiresAt: Date; revoked: boolean }>();
  readonly audit: Array<Readonly<{ organizationId: string; actorKind: string; actorId: string | null; action: string; targetMemberId: string | null; details: Readonly<Record<string, unknown>> }>> = [];

  static readonly TEMPLATES: Array<{ code: OrgStaffRoleCode; label: string; description: string }> = [
    { code: 'application_manager', label: 'Application Manager', description: 'Manages assigned application workflows (Q117).' },
    { code: 'finance_viewer', label: 'Finance Viewer', description: 'Read-only financial reports (Q117).' },
    { code: 'invigilator', label: 'Invigilator', description: 'Assigned examination sessions only (Q117).' },
    { code: 'reviewer', label: 'Reviewer', description: 'Reviews applications (Q117).' },
    { code: 'verifier', label: 'Verifier', description: 'Verifies application details and documents (Q117).' },
    { code: 'viewer', label: 'Viewer', description: 'Read-only access to permitted modules (Q117).' },
  ];

  private record(event: { organizationId: string; actorKind: string; actorId: string | null; action: string; targetMemberId: string | null; details?: Record<string, unknown> }) {
    this.audit.push(Object.freeze({ ...event, details: Object.freeze({ ...(event.details ?? {}) }) }));
  }

  private view(member: OrgMember, now: Date): OrgStaffMemberView {
    const invitation = this.invitations.filter((i) => i.memberId === member.id && i.organizationId === member.organizationId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    const state = !invitation ? 'none' : invitation.usedAt ? 'used' : invitation.expiresAt > now ? 'live' : 'expired';
    return {
      id: member.id, staffId: member.staffId, displayName: member.displayName, status: member.status,
      accepted: Boolean(member.acceptedAt), verified: Boolean(member.verifiedAt), roles: [...member.roles].sort(),
      invitation: { state, expiresAt: invitation ? invitation.expiresAt.toISOString() : null }, createdAt: member.createdAt.toISOString(),
    };
  }

  private memberInOrg(organizationId: string, memberId: string) {
    const member = this.members.get(memberId);
    if (!member || member.organizationId !== organizationId) throw new StaffNotFoundError('Staff member not found in your organization.');
    return member;
  }

  async listRoleTemplates() { return MemoryOrgStaffStore.TEMPLATES; }
  async listMembers(organizationId: string, now: Date) {
    return [...this.members.values()].filter((m) => m.organizationId === organizationId).map((m) => this.view(m, now));
  }
  async createInvitation(organizationId: string, input: { staffId: string; displayName: string; codeHash: string; expiresAt: Date }, ownerId: string) {
    if ([...this.members.values()].some((m) => m.organizationId === organizationId && m.staffId === input.staffId)) throw new StaffConflictError('That Staff ID is already used in this organization.');
    const member: OrgMember = { id: randomUUID(), organizationId, staffId: input.staffId, displayName: input.displayName, passwordHash: null, status: 'invited', acceptedAt: null, verifiedAt: null, activatedBy: null, roles: [], createdAt: new Date() };
    this.members.set(member.id, member);
    this.invitations.push({ memberId: member.id, organizationId, codeHash: input.codeHash, expiresAt: input.expiresAt, usedAt: null, createdAt: new Date() });
    this.record({ organizationId, actorKind: 'organization_owner', actorId: ownerId, action: 'member.invited', targetMemberId: member.id, details: { staffId: input.staffId } });
    return this.view(member, new Date());
  }
  async setMemberRoles(organizationId: string, memberId: string, roleCodes: OrgStaffRoleCode[], ownerId: string) {
    const member = this.memberInOrg(organizationId, memberId);
    if (member.status === 'removed') throw new StaffConflictError('Roles cannot be assigned to a removed member.');
    const before = [...member.roles];
    member.roles = [...roleCodes];
    this.record({ organizationId, actorKind: 'organization_owner', actorId: ownerId, action: 'member.roles_changed', targetMemberId: memberId, details: { before, after: [...roleCodes] } });
    return this.view(member, new Date());
  }
  async acceptInvitation(input: { organizationLoginId: string; staffId: string; codeHash: string; passwordHash: string; now: Date }) {
    const invitation = this.invitations.find((i) => i.codeHash === input.codeHash);
    if (!invitation || invitation.usedAt || invitation.expiresAt <= input.now) return false;
    const member = this.members.get(invitation.memberId);
    const organization = this.organizations.get(invitation.organizationId);
    if (!member || member.organizationId !== invitation.organizationId || !organization || !organization.approved) return false;
    if (organization.loginId !== input.organizationLoginId || member.staffId !== input.staffId || member.status !== 'invited' || member.passwordHash !== null) return false;
    invitation.usedAt = input.now;
    member.passwordHash = input.passwordHash;
    member.acceptedAt = input.now;
    this.record({ organizationId: member.organizationId, actorKind: 'anonymous', actorId: null, action: 'member.invitation_accepted', targetMemberId: member.id });
    return true;
  }
  async findLoginRecord(organizationLoginId: string, staffId: string) {
    const organization = [...this.organizations.values()].find((o) => o.loginId === organizationLoginId);
    const member = organization ? [...this.members.values()].find((m) => m.organizationId === organization.id && m.staffId === staffId) : undefined;
    return organization && member ? { memberId: member.id, organizationId: organization.id, passwordHash: member.passwordHash, status: member.status, organizationApproved: organization.approved } : null;
  }
  async startSession(memberId: string, organizationId: string, tokenHash: string, expiresAt: Date) {
    this.sessions.set(tokenHash, { memberId, organizationId, expiresAt, revoked: false });
    this.record({ organizationId, actorKind: 'org_staff', actorId: memberId, action: 'auth.login_succeeded', targetMemberId: memberId });
  }
  async recordLoginFailure(organizationId: string | null, memberId: string | null) {
    if (organizationId) this.record({ organizationId, actorKind: 'anonymous', actorId: null, action: 'auth.login_failed', targetMemberId: memberId });
  }
  async loadSession(tokenHash: string, now: Date): Promise<OrgStaffSessionView | null> {
    const session = this.sessions.get(tokenHash);
    if (!session || session.revoked || session.expiresAt <= now) return null;
    const member = this.members.get(session.memberId);
    const organization = this.organizations.get(session.organizationId);
    if (!member || member.organizationId !== session.organizationId || member.status !== 'active' || !organization?.approved) return null;
    return { memberId: member.id, organizationId: organization.id, organizationName: organization.name, staffId: member.staffId, displayName: member.displayName, roles: [...member.roles].sort() };
  }
  async endSession(tokenHash: string, memberId: string, organizationId: string) {
    const session = this.sessions.get(tokenHash);
    if (session && session.memberId === memberId && session.organizationId === organizationId) session.revoked = true;
    this.record({ organizationId, actorKind: 'org_staff', actorId: memberId, action: 'auth.logout', targetMemberId: memberId });
  }
  async listForActivation(): Promise<OrgStaffActivationView[]> {
    return [...this.members.values()].filter((m) => m.status === 'invited').map((m) => {
      const organization = this.organizations.get(m.organizationId)!;
      return { id: m.id, organizationName: organization.name, organizationLoginId: organization.loginId, staffId: m.staffId, displayName: m.displayName, status: m.status, accepted: Boolean(m.acceptedAt), verified: Boolean(m.verifiedAt), createdAt: m.createdAt.toISOString() };
    });
  }
  async activateMember(memberId: string, superAdminId: string) {
    const member = this.members.get(memberId);
    if (!member) return 'not_found' as const;
    if (member.status !== 'invited') return 'not_invited' as const;
    if (!member.acceptedAt || !member.verifiedAt) {
      this.record({ organizationId: member.organizationId, actorKind: 'super_admin', actorId: superAdminId, action: 'member.activation_refused', targetMemberId: memberId, details: { reason: 'not_verified' } });
      return 'not_verified' as const;
    }
    member.status = 'active';
    member.activatedBy = superAdminId;
    this.record({ organizationId: member.organizationId, actorKind: 'super_admin', actorId: superAdminId, action: 'member.activated', targetMemberId: memberId });
    return 'activated' as const;
  }

  /**
   * Test-only: represents a member who has completed a FUTURE approved verification method. No
   * production code path can set verified_at today (C-18).
   */
  markVerifiedForTest(memberId: string) {
    this.members.get(memberId)!.verifiedAt = new Date();
  }
}
