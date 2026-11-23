export type SecurityEventCode =
  | 'verifier_started'
  | 'verifier_startup_failed'
  | 'request_rejected'
  | 'request_rate_limited';

export interface SecurityEvent {
  readonly event: SecurityEventCode;
  readonly outcome: 'success' | 'failure';
  readonly code?: string;
  readonly route?: '/healthz' | '/readyz' | 'other';
}

export interface SecurityEventLogger {
  write(event: SecurityEvent): void;
}

export class JsonSecurityEventLogger implements SecurityEventLogger {
  write(event: SecurityEvent): void {
    const safeEvent: SecurityEvent = {
      event: event.event,
      outcome: event.outcome,
      ...(event.code === undefined ? {} : { code: event.code }),
      ...(event.route === undefined ? {} : { route: event.route }),
    };
    process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...safeEvent })}\n`);
  }
}
