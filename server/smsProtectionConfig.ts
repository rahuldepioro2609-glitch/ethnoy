// AUTH C1 / C1.1-b / C1.3: SMS abuse-protection settings: the ONE authoritative parser and validator.
//
// PURE module: it imports only OTP_POLICY (for the challenge-lifetime ceiling of the claim lifetime)
// from verificationProviders.ts, which itself imports only node:crypto and node:fs. No Express,
// database, dotenv or store is reachable from here, so the deployment preflight
// (validateDeploymentConfig.ts), API startup and every request share exactly this code.
// Values are PENDING OWNER APPROVAL: there are no defaults, and nothing here ever prints a value.
import { OTP_POLICY } from './verificationProviders.js';

export interface SmsDestinationLimit {
  /** Rolling window for the per-destination limit of this bucket. */
  windowMs: number;
  /** Maximum SMS reservations to one destination within the window, in this bucket. */
  maxSends: number;
}

export interface SmsSendLimits {
  /** Registration, capture, Institute and every other SMS that does not qualify as verified. */
  unverified: SmsDestinationLimit;
  /** Student sign-in to the account's current verified mobile. */
  verified: SmsDestinationLimit;
  /** AUTH C1.1-b C-1: an APPROVED Institute's own recorded mobile, counted per (account, destination). */
  account: SmsDestinationLimit;
  /** All SMS (every purpose, both buckets) in any rolling 24 hours: the shared spend guard. */
  dailyMaxSends: number;
  /** Unverified (anonymous) SMS in any rolling 24 hours; never above dailyMaxSends, so the rest stays for
   *  sign-in and approved accounts. Account-bucket sends count only towards dailyMaxSends. */
  dailyMaxUnverifiedSends: number;
}

/**
 * AUTH C1.4-B-1: email limits. Two buckets only: 'unverified' (anonymous: new and pending Institutes)
 * and 'account' (an APPROVED Institute's own recorded address). There is no email 'verified' bucket.
 */
export interface EmailSendLimits {
  unverified: SmsDestinationLimit;
  account: SmsDestinationLimit;
  /** All email sends (both buckets) in any rolling 24 hours. */
  dailyMaxSends: number;
  /** Unverified (anonymous) email sends in any rolling 24 hours; never above dailyMaxSends. */
  dailyMaxUnverifiedSends: number;
}

export interface AbuseProtectionConfig {
  /** null = not configured (or invalid): EVERY SMS is refused (fail closed). */
  sms: SmsSendLimits | null;
  /** AUTH C1.4-B-1: null = not configured (or invalid): EVERY email is refused (fail closed). */
  email: EmailSendLimits | null;
  /** AUTH C1.4-B-1: status of every email setting, by name (never values). */
  emailSettings?: Readonly<Record<string, AbuseProtectionSettingStatus>>;
  /** Pending registration claim lifetime; null = not configured: registration is refused. */
  registrationClaimTtlMs: number | null;
  /** Names of missing or invalid settings (never values). */
  problems: string[];
  /** C1.3-A: status of every setting, by name (never values). Set by resolveAbuseProtection. */
  settings?: Readonly<Record<string, AbuseProtectionSettingStatus>>;
}

/** C1.3-A: per-setting status for readiness reporting. Never carries the value. */
export type AbuseProtectionSettingStatus = 'valid' | 'missing' | 'invalid' | 'inconsistent';

export const ABUSE_PROTECTION_SETTINGS = Object.freeze({
  unverifiedWindow: 'AUTH_SMS_UNVERIFIED_DESTINATION_WINDOW_SECONDS',
  unverifiedMaxSends: 'AUTH_SMS_UNVERIFIED_DESTINATION_MAX_SENDS',
  verifiedWindow: 'AUTH_SMS_VERIFIED_DESTINATION_WINDOW_SECONDS',
  verifiedMaxSends: 'AUTH_SMS_VERIFIED_DESTINATION_MAX_SENDS',
  accountWindow: 'AUTH_SMS_ACCOUNT_DESTINATION_WINDOW_SECONDS',
  accountMaxSends: 'AUTH_SMS_ACCOUNT_DESTINATION_MAX_SENDS',
  dailyMaxSends: 'AUTH_SMS_DAILY_MAX_SENDS',
  dailyMaxUnverifiedSends: 'AUTH_SMS_DAILY_MAX_UNVERIFIED_SENDS',
  registrationClaimTtl: 'AUTH_STUDENT_REGISTRATION_CLAIM_TTL_SECONDS',
});

/**
 * Reads the AUTH C1 / C1.1-b limits. Each must be a positive whole number; the unverified daily cap may
 * not exceed the shared daily total; the claim lifetime may not exceed the verification challenge
 * lifetime. Any missing, invalid or inconsistent SMS value leaves SMS protection unconfigured, which
 * refuses every SMS. There are no defaults: the values are pending owner approval. (The C1 settings
 * AUTH_SMS_DESTINATION_WINDOW_SECONDS / AUTH_SMS_DESTINATION_MAX_SENDS are no longer read.)
 */
export function resolveAbuseProtection(env: Readonly<Record<string, string | undefined>> = process.env): AbuseProtectionConfig {
  const problems: string[] = [];
  const settings: Record<string, AbuseProtectionSettingStatus> = {};
  const read = (name: string, max?: number): number | null => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') { problems.push(`${name} is not set`); settings[name] = 'missing'; return null; }
    if (!/^[1-9][0-9]{0,8}$/.test(raw.trim())) { problems.push(`${name} must be a positive whole number`); settings[name] = 'invalid'; return null; }
    const value = Number(raw.trim());
    if (max !== undefined && value > max) { problems.push(`${name} must not exceed ${max}`); settings[name] = 'invalid'; return null; }
    settings[name] = 'valid';
    return value;
  };
  const S = ABUSE_PROTECTION_SETTINGS;
  const unverifiedWindow = read(S.unverifiedWindow);
  const unverifiedMax = read(S.unverifiedMaxSends);
  const verifiedWindow = read(S.verifiedWindow);
  const verifiedMax = read(S.verifiedMaxSends);
  const accountWindow = read(S.accountWindow);
  const accountMax = read(S.accountMaxSends);
  const daily = read(S.dailyMaxSends);
  const dailyUnverified = read(S.dailyMaxUnverifiedSends);
  let consistent = true;
  if (daily !== null && dailyUnverified !== null && dailyUnverified > daily) {
    problems.push(`${S.dailyMaxUnverifiedSends} must not exceed ${S.dailyMaxSends}`);
    settings[S.dailyMaxUnverifiedSends] = 'inconsistent';
    consistent = false;
  }
  const ttl = read(S.registrationClaimTtl, Math.floor(OTP_POLICY.challengeTtlMs / 1000));
  const complete = unverifiedWindow !== null && unverifiedMax !== null && verifiedWindow !== null && verifiedMax !== null
    && accountWindow !== null && accountMax !== null && daily !== null && dailyUnverified !== null;
  return {
    sms: complete && consistent
      ? {
        unverified: { windowMs: unverifiedWindow * 1000, maxSends: unverifiedMax },
        verified: { windowMs: verifiedWindow * 1000, maxSends: verifiedMax },
        account: { windowMs: accountWindow * 1000, maxSends: accountMax },
        dailyMaxSends: daily,
        dailyMaxUnverifiedSends: dailyUnverified,
      }
      : null,
    registrationClaimTtlMs: ttl === null ? null : ttl * 1000,
    problems,
    settings: Object.freeze(settings),
    ...resolveEmailProtection(env),
  };
}

/** AUTH C1.4-B-1: the six email settings (a separate all-or-nothing group from the SMS settings). */
export const EMAIL_PROTECTION_SETTINGS = Object.freeze({
  unverifiedWindow: 'AUTH_EMAIL_UNVERIFIED_DESTINATION_WINDOW_SECONDS',
  unverifiedMaxSends: 'AUTH_EMAIL_UNVERIFIED_DESTINATION_MAX_SENDS',
  accountWindow: 'AUTH_EMAIL_ACCOUNT_DESTINATION_WINDOW_SECONDS',
  accountMaxSends: 'AUTH_EMAIL_ACCOUNT_DESTINATION_MAX_SENDS',
  dailyMaxSends: 'AUTH_EMAIL_DAILY_MAX_SENDS',
  dailyMaxUnverifiedSends: 'AUTH_EMAIL_DAILY_MAX_UNVERIFIED_SENDS',
});
export const EMAIL_PROTECTION_SETTING_NAMES: readonly string[] = Object.freeze(Object.values(EMAIL_PROTECTION_SETTINGS));

/**
 * AUTH C1.4-B-1: same rules as the SMS group, applied independently: every value a positive whole
 * number, the unverified daily cap not above the total, and all six valid or the group is null (every
 * email refused). There are no defaults: the values are pending owner approval.
 */
export function resolveEmailProtection(env: Readonly<Record<string, string | undefined>>): Pick<AbuseProtectionConfig, 'email' | 'emailSettings'> {
  const settings: Record<string, AbuseProtectionSettingStatus> = {};
  const read = (name: string): number | null => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') { settings[name] = 'missing'; return null; }
    if (!/^[1-9][0-9]{0,8}$/.test(raw.trim())) { settings[name] = 'invalid'; return null; }
    settings[name] = 'valid';
    return Number(raw.trim());
  };
  const E = EMAIL_PROTECTION_SETTINGS;
  const unverifiedWindow = read(E.unverifiedWindow);
  const unverifiedMax = read(E.unverifiedMaxSends);
  const accountWindow = read(E.accountWindow);
  const accountMax = read(E.accountMaxSends);
  const daily = read(E.dailyMaxSends);
  const dailyUnverified = read(E.dailyMaxUnverifiedSends);
  let consistent = true;
  if (daily !== null && dailyUnverified !== null && dailyUnverified > daily) {
    settings[E.dailyMaxUnverifiedSends] = 'inconsistent';
    consistent = false;
  }
  const complete = unverifiedWindow !== null && unverifiedMax !== null && accountWindow !== null && accountMax !== null && daily !== null && dailyUnverified !== null;
  return {
    email: complete && consistent
      ? {
        unverified: { windowMs: unverifiedWindow * 1000, maxSends: unverifiedMax },
        account: { windowMs: accountWindow * 1000, maxSends: accountMax },
        dailyMaxSends: daily,
        dailyMaxUnverifiedSends: dailyUnverified,
      }
      : null,
    emailSettings: Object.freeze(settings),
  };
}

/** AUTH C1.4-B-1: secret-free email readiness (statuses only, never values). */
export function emailProtectionReadiness(config: AbuseProtectionConfig) {
  return {
    emailProtectionConfigured: config.email !== null,
    emailSettings: Object.fromEntries(EMAIL_PROTECTION_SETTING_NAMES.map((name) => [name, config.emailSettings?.[name] ?? 'missing'])),
  };
}

/** The eight SMS settings (all required for any SMS); the claim lifetime is reported separately. */
export const SMS_PROTECTION_SETTING_NAMES: readonly string[] = Object.freeze(Object.entries(ABUSE_PROTECTION_SETTINGS)
  .filter(([key]) => key !== 'registrationClaimTtl').map(([, name]) => name));

/**
 * C1.3-A: secret-free readiness summary for the startup log. Statuses and booleans only: no value,
 * path, number, destination or key ever appears. SMS protection being configured does NOT mean SMS
 * can be delivered: that also needs a registered provider (reported separately).
 */
export function abuseProtectionReadiness(config: AbuseProtectionConfig) {
  const status = (name: string): AbuseProtectionSettingStatus => config.settings?.[name] ?? 'missing';
  return {
    smsProtectionConfigured: config.sms !== null,
    registrationClaimTtlConfigured: config.registrationClaimTtlMs !== null,
    smsSettings: Object.fromEntries(SMS_PROTECTION_SETTING_NAMES.map((name) => [name, status(name)])),
    registrationClaimTtlSetting: { [ABUSE_PROTECTION_SETTINGS.registrationClaimTtl]: status(ABUSE_PROTECTION_SETTINGS.registrationClaimTtl) },
  };
}

/**
 * C1.3-B deployment preflight rule (approved, fail-fast). Returns errors that name settings and
 * statuses only, never values.
 * - The eight SMS settings are all-or-nothing: all missing or empty is accepted (SMS stays closed);
 *   all valid and consistent is accepted; anything else (a partial set, an invalid or an
 *   inconsistent value) is rejected.
 * - The claim lifetime is independent: missing or empty is accepted (Student registration stays
 *   closed); a set but invalid value (not a positive whole number, or above the challenge lifetime)
 *   is rejected.
 */
export function validateSmsProtectionDeployment(env: Readonly<Record<string, string | undefined>>): string[] {
  const readiness = abuseProtectionReadiness(resolveAbuseProtection(env));
  const errors: string[] = [];
  const sms = Object.entries(readiness.smsSettings);
  const allMissing = sms.every(([, status]) => status === 'missing');
  if (!allMissing) {
    for (const [name, status] of sms) {
      if (status !== 'valid') {
        errors.push(status === 'missing'
          ? `${name} is missing: the eight AUTH_SMS_* settings must be set together (all of them or none).`
          : status === 'inconsistent'
            ? `${name} is inconsistent: it must not exceed ${ABUSE_PROTECTION_SETTINGS.dailyMaxSends}.`
            : `${name} is invalid: it must be a positive whole number.`);
      }
    }
  }
  const ttlName = ABUSE_PROTECTION_SETTINGS.registrationClaimTtl;
  if (readiness.registrationClaimTtlSetting[ttlName] === 'invalid') {
    errors.push(`${ttlName} is invalid: it must be a positive whole number no greater than the verification challenge lifetime.`);
  }
  return errors;
}

/**
 * AUTH C1.4-B-2 deployment preflight rule for the six email settings (approved, fail-fast), applied by
 * the host wrapper and the in-container preflight alike. Errors name settings and statuses only.
 * - All six missing or empty: accepted (every email stays refused).
 * - All six valid and consistent: accepted.
 * - Anything else (a partial set, an invalid or an inconsistent value): rejected.
 * Independent of the SMS rule, which is unchanged.
 */
export function validateEmailProtectionDeployment(env: Readonly<Record<string, string | undefined>>): string[] {
  const statuses = EMAIL_PROTECTION_SETTING_NAMES.map((name) => [name, resolveEmailProtection(env).emailSettings?.[name] ?? 'missing'] as const);
  if (statuses.every(([, status]) => status === 'missing')) return [];
  return statuses.filter(([, status]) => status !== 'valid').map(([name, status]) => (status === 'missing'
    ? `${name} is missing: the six AUTH_EMAIL_* settings must be set together (all of them or none).`
    : status === 'inconsistent'
      ? `${name} is inconsistent: it must not exceed ${EMAIL_PROTECTION_SETTINGS.dailyMaxSends}.`
      : `${name} is invalid: it must be a positive whole number.`));
}
