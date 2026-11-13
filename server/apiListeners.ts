// P1-B: two-listener lifecycle (P1 Surface Isolation v1.4 §10), with the L-1 remediation.
//
// Startup: validate online-exam settings → check the database → bind the public listener → bind the
// Admin listener → mark ready → start online-exam recovery exactly once. If either bind fails, or
// anything fails after the binds but before startup completes, every bound listener is closed,
// readiness is reset to false and startup fails; recovery never starts on partial startup.
// After binding, each listener keeps a persistent 'error' handler: a later listener error marks the
// API not ready and triggers the single, idempotent graceful shutdown (exit code 1).
// Shutdown: mark not ready → stop recovery → close both listeners → end the pool.
//
// Servers are injected (createServer), so unit tests use event-emitter fakes and never bind real
// sockets. P0-4 timing, grace period, scoring and finalization are untouched.
import type { OnlineExamConfig } from './onlineExamFinalization.js';
import {
  createGracefulShutdown,
  startApiWithOnlineExamRecovery,
  type ApiStartupResult,
  type ListeningServer,
  type OnlineExamRecoveryHandle,
  type ShutdownLogEntry,
  type StartupLogEntry,
} from './onlineExamRecovery.js';
import { isListenerName, LISTENERS, type ListenerName } from './surface.js';
import type { SurfaceMode } from './surfaceEnforcement.js';

// ---------------------------------------------------------------------------
// Listener selection and recovery ownership (P1-D.2, Option B)
// ---------------------------------------------------------------------------

export const API_LISTENERS_SETTING = 'ELTNOY_API_LISTENERS';

export type ActiveListenersResult = { ok: true; listeners: readonly ListenerName[] } | { ok: false; errors: string[] };

/**
 * Validates ELTNOY_API_LISTENERS: exactly `public` or `admin` (one instance per listener, as in
 * the production Compose topology), or `public,admin` only in development. There is no default:
 * an unset, empty, unknown, duplicated or malformed value is rejected, so an instance never falls
 * back to both listeners. Recovery is owned by the public instance: ONLINE_EXAM_RECOVERY_SINCE is
 * rejected on an instance without the public listener. Messages contain no configured values.
 */
export function resolveActiveListeners(env: Readonly<Record<string, string | undefined>>, mode: SurfaceMode): ActiveListenersResult {
  const raw = env[API_LISTENERS_SETTING];
  const errors: string[] = [];
  if (raw === undefined || raw.trim() === '') {
    return { ok: false, errors: [`${API_LISTENERS_SETTING} must be set to public or admin (public,admin is allowed only in development).`] };
  }
  const entries = raw.split(',').map((entry) => entry.trim());
  const selected = new Set<ListenerName>();
  entries.forEach((entry, index) => {
    if (entry === '') {
      errors.push(`${API_LISTENERS_SETTING} entry ${index + 1} is empty.`);
    } else if (!isListenerName(entry)) {
      errors.push(`${API_LISTENERS_SETTING} entry ${index + 1} is not public or admin.`);
    } else if (selected.has(entry)) {
      errors.push(`${API_LISTENERS_SETTING} entry ${index + 1} is a duplicate.`);
    } else {
      selected.add(entry);
    }
  });
  if (errors.length === 0 && selected.size > 1 && mode !== 'development') {
    errors.push(`${API_LISTENERS_SETTING}=public,admin is allowed only when ELTNOY_SURFACE_MODE is development; production and staging run one listener per instance.`);
  }
  const recoverySince = env.ONLINE_EXAM_RECOVERY_SINCE;
  if (errors.length === 0 && !selected.has('public') && recoverySince !== undefined && recoverySince.trim() !== '') {
    errors.push('ONLINE_EXAM_RECOVERY_SINCE must not be set on an instance without the public listener; online-exam recovery is owned by the public instance.');
  }
  if (errors.length > 0) return { ok: false, errors };
  // Canonical order (public before admin) regardless of how the value was written.
  return { ok: true, listeners: Object.freeze(LISTENERS.filter((listener) => selected.has(listener))) };
}

/**
 * The recovery handle for an instance that does not own recovery (no public listener). It never
 * schedules, sweeps or touches the database; P0-4 recovery itself is unchanged.
 */
export const NO_RECOVERY_HANDLE: OnlineExamRecoveryHandle = Object.freeze({
  enabled: false,
  runNow: async () => null,
  idle: async () => undefined,
  stop: async () => undefined,
});

/** The part of http.Server used here. */
export interface ListenerServer {
  listen(port: number, host: string): unknown;
  close(callback: (error?: Error) => void): unknown;
  once(event: 'listening' | 'error', listener: (...args: unknown[]) => void): unknown;
  on(event: 'error', listener: (...args: unknown[]) => void): unknown;
  removeListener(event: 'listening' | 'error', listener: (...args: unknown[]) => void): unknown;
}

export interface ListenerSpec {
  name: ListenerName;
  port: number;
  host: string;
}

export type ListenerSet<S extends ListenerServer> = ReadonlyMap<ListenerName, S>;

export class ListenerStartupError extends Error {
  constructor(readonly listener: ListenerName, readonly code: string | undefined) {
    super(`The ${listener} listener could not start${code ? ` (${code})` : ''}.`);
    this.name = 'ListenerStartupError';
  }
}

/** A listener error after a successful bind (L-1). */
export class ListenerRuntimeError extends Error {
  constructor(readonly listener: ListenerName, readonly code: string | undefined) {
    super(`The ${listener} listener failed${code ? ` (${code})` : ''}.`);
    this.name = 'ListenerRuntimeError';
  }
}

function errorCode(error: unknown): string | undefined {
  const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : undefined;
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : undefined;
}

// ---------------------------------------------------------------------------
// Server-side listener wiring (M-2)
// ---------------------------------------------------------------------------

/**
 * Builds the request handler for one listener: the listener identity is fixed here, by server code,
 * for every request that listener accepts; nothing in the request can choose it. If tagging fails
 * (it never should), the request is answered 500 and the application is not invoked.
 */
export function createListenerRequestHandler<Req, Res extends { statusCode: number; end(): unknown }>(
  listener: ListenerName,
  tagListener: (request: Req, listener: ListenerName) => void,
  handle: (request: Req, response: Res) => void,
): (request: Req, response: Res) => void {
  if (!isListenerName(listener)) throw new Error('Unknown listener.');
  return (request, response) => {
    try {
      tagListener(request, listener);
    } catch {
      response.statusCode = 500;
      response.end();
      return;
    }
    handle(request, response);
  };
}

// ---------------------------------------------------------------------------
// Binding and closing
// ---------------------------------------------------------------------------

function bind<S extends ListenerServer>(server: S, spec: ListenerSpec): Promise<void> {
  return new Promise((resolve, reject) => {
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    const onError = (error: unknown) => {
      server.removeListener('listening', onListening);
      reject(new ListenerStartupError(spec.name, errorCode(error)));
    };
    server.once('listening', onListening);
    server.once('error', onError);
    try {
      server.listen(spec.port, spec.host);
    } catch (error) {
      server.removeListener('listening', onListening);
      server.removeListener('error', onError);
      reject(new ListenerStartupError(spec.name, errorCode(error)));
    }
  });
}

function closeServer(server: ListenerServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Closes every listener (all are attempted even if one fails), then rejects with the first error.
 */
export async function closeListeners(servers: Iterable<ListenerServer>): Promise<void> {
  const results = await Promise.allSettled([...servers].map((server) => closeServer(server)));
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure) throw failure.reason;
}

/**
 * Binds the listeners in order. After each successful bind a persistent 'error' handler is attached
 * (L-1), so a later listener error is never unhandled; it is reported to `onRuntimeError`.
 * On the first bind failure, closes the listeners that already bound and rejects with
 * ListenerStartupError; later listeners are not attempted.
 */
export async function startListeners<S extends ListenerServer>(
  specs: readonly ListenerSpec[],
  createServer: (spec: ListenerSpec) => S,
  onRuntimeError: (error: ListenerRuntimeError) => void = () => undefined,
): Promise<ListenerSet<S>> {
  const names = specs.map((spec) => spec.name);
  if (new Set(names).size !== names.length || new Set(specs.map((spec) => spec.port)).size !== specs.length) {
    throw new Error('Listener names and ports must be unique.');
  }
  const bound = new Map<ListenerName, S>();
  for (const spec of specs) {
    const server = createServer(spec);
    try {
      await bind(server, spec);
    } catch (error) {
      try {
        await closeListeners(bound.values());
      } catch {
        // The startup error is the one reported; the process exits non-zero either way.
      }
      throw error;
    }
    server.on('error', (error: unknown) => {
      try {
        onRuntimeError(new ListenerRuntimeError(spec.name, errorCode(error)));
      } catch {
        // Error reporting must never throw from an 'error' event.
      }
    });
    bound.set(spec.name, server);
  }
  return bound;
}

/** Recovery starts from this object: it reports listening only once every listener is bound. */
const ALL_LISTENERS_READY: ListeningServer = Object.freeze({
  listening: true,
  once: () => undefined,
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

export interface TwoListenerStartupSteps<S extends ListenerServer> {
  specs: readonly ListenerSpec[];
  createServer: (spec: ListenerSpec) => S;
  loadOnlineExamConfig: () => OnlineExamConfig;
  checkDatabase: () => Promise<void>;
  startRecovery: (config: OnlineExamConfig) => OnlineExamRecoveryHandle;
  /** Health readiness (D9): called once, after every listener is bound and before recovery. */
  markReady: () => void;
  /** L-1: called on any startup failure (readiness back to false). */
  markNotReady: () => void;
  /** L-1: a listener error after its bind. */
  onListenerError?: (error: ListenerRuntimeError) => void;
  log?: (entry: StartupLogEntry) => void;
}

export interface TwoListenerStartupResult<S extends ListenerServer> extends Omit<ApiStartupResult<ListeningServer>, 'server'> {
  servers: ListenerSet<S>;
}

/**
 * Starts the API on all listeners. Returns null for invalid online-exam settings (nothing bound).
 * Rejects — with readiness reset and every bound listener closed — if the database check, any
 * bind, a listener error during startup, or anything after the binds fails.
 */
export async function startApiListeners<S extends ListenerServer>(
  steps: TwoListenerStartupSteps<S>,
): Promise<TwoListenerStartupResult<S> | null> {
  let servers: ListenerSet<S> | null = null;
  let runtimeError: ListenerRuntimeError | null = null;
  const onRuntimeError = (error: ListenerRuntimeError) => {
    runtimeError ??= error;
    steps.onListenerError?.(error);
  };
  let started: Awaited<ReturnType<typeof startApiWithOnlineExamRecovery<ListeningServer>>>;
  try {
    started = await startApiWithOnlineExamRecovery({
      loadOnlineExamConfig: steps.loadOnlineExamConfig,
      checkDatabase: steps.checkDatabase,
      listen: async () => {
        servers = await startListeners(steps.specs, steps.createServer, onRuntimeError);
        // A listener that failed between its bind and now must not be reported ready.
        if (runtimeError) throw runtimeError;
        steps.markReady();
        return ALL_LISTENERS_READY;
      },
      startRecovery: steps.startRecovery,
      log: steps.log,
    });
  } catch (error) {
    try {
      steps.markNotReady();
    } catch {
      // Keep the original startup error.
    }
    if (servers) {
      try {
        await closeListeners((servers as ListenerSet<S>).values());
      } catch {
        // The startup error is the one reported.
      }
    }
    throw error;
  }
  if (!started) return null;
  if (!servers) throw new Error('Listeners were not started.');
  return { servers, config: started.config, recovery: started.recovery };
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

export interface TwoListenerShutdownSteps {
  recovery: { stop(): Promise<void> };
  servers: ListenerSet<ListenerServer>;
  endPool: () => Promise<void>;
  exit: (code: number) => void;
  /** Readiness back to false as shutdown begins. */
  markNotReady?: () => void;
  log?: (entry: ShutdownLogEntry) => void;
}

/** Idempotent shutdown: mark not ready → stop recovery → close both listeners → end the pool → exit. */
export function createTwoListenerShutdown(steps: TwoListenerShutdownSteps): (signal: string) => Promise<void> {
  return createGracefulShutdown({
    stopRecovery: async () => {
      try {
        steps.markNotReady?.();
      } catch {
        // Readiness reporting must not block shutdown.
      }
      await steps.recovery.stop();
    },
    closeServer: () => closeListeners(steps.servers.values()),
    endPool: steps.endPool,
    exit: steps.exit,
    log: steps.log,
  });
}

// ---------------------------------------------------------------------------
// Runtime: startup + fatal listener errors + shutdown (L-1)
// ---------------------------------------------------------------------------

export interface ApiRuntimeSteps<S extends ListenerServer> extends Omit<TwoListenerStartupSteps<S>, 'onListenerError'> {
  endPool: () => Promise<void>;
  exit: (code: number) => void;
  shutdownLog?: (entry: ShutdownLogEntry) => void;
  /** Safe log entry for a fatal listener error (listener name and error code only). */
  onFatalListenerError?: (entry: { event: 'api.listener_failed'; listener: ListenerName; code?: string }) => void;
}

export interface ApiRuntime<S extends ListenerServer> extends TwoListenerStartupResult<S> {
  /** The single idempotent shutdown, shared by signals and fatal listener errors. */
  shutdown: (signal: string) => Promise<void>;
}

/**
 * Starts the API and connects fatal listener errors to the graceful shutdown. A listener error after
 * startup marks the API not ready and runs the shared shutdown once (exit code 1); repeated errors
 * and signals reuse the same shutdown promise, so there is no shutdown/error-handler loop.
 */
export async function startApiRuntime<S extends ListenerServer>(steps: ApiRuntimeSteps<S>): Promise<ApiRuntime<S> | null> {
  let shutdown: ((signal: string) => Promise<void>) | null = null;
  let fatal = false;
  const onListenerError = (error: ListenerRuntimeError) => {
    const firstFailure = !fatal;
    fatal = true;
    try {
      steps.markNotReady();
    } catch {
      // Readiness reporting must not block the failure path.
    }
    if (firstFailure) {
      try {
        steps.onFatalListenerError?.({ event: 'api.listener_failed', listener: error.listener, code: error.code });
      } catch {
        // Logging must not block the failure path.
      }
    }
    if (shutdown) void shutdown('listener_error');
  };
  const started = await startApiListeners({ ...steps, onListenerError });
  if (!started) return null;
  const runShutdown = createTwoListenerShutdown({
    recovery: started.recovery,
    servers: started.servers,
    endPool: steps.endPool,
    exit: (code) => steps.exit(fatal ? 1 : code),
    markNotReady: steps.markNotReady,
    log: steps.shutdownLog,
  });
  shutdown = runShutdown;
  // An error reported after the binds but in the same turn as startup completion.
  if (fatal) void runShutdown('listener_error');
  return { ...started, shutdown: runShutdown };
}
