export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /** Machine-readable `code` from the error body, when the API provides one (optional). */
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });

  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      const body = await response.json() as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Keep the HTTP status message when the server does not return JSON.
    }
    throw new ApiError(message, response.status);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export interface ApiResponseWithMeta<T> {
  data: T;
  status: number;
  /** The response's HTTP `Date` header (server clock, one-second resolution), or null if absent. */
  serverDate: string | null;
}

/**
 * Like apiRequest, but also returns the HTTP status and the server's `Date` header, and puts the
 * body's `code` on ApiError. `timeoutMs` aborts a request that takes too long; the abort surfaces
 * as a network-type error (not an ApiError), so callers treat it as "not confirmed".
 */
export async function apiRequestWithMeta<T>(
  path: string,
  options: RequestInit = {},
  timeoutMs?: number,
): Promise<ApiResponseWithMeta<T>> {
  const controller = timeoutMs ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(path, {
      ...options,
      ...(controller ? { signal: controller.signal } : {}),
      credentials: 'same-origin',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    });
    const serverDate = response.headers.get('date');
    if (!response.ok) {
      let message = `Request failed (${response.status}).`;
      let code: string | undefined;
      try {
        const body = await response.json() as { error?: string; code?: unknown };
        if (body.error) message = body.error;
        if (typeof body.code === 'string') code = body.code;
      } catch {
        // Keep the HTTP status message when the server does not return JSON.
      }
      throw new ApiError(message, response.status, code);
    }
    const data = (response.status === 204 ? undefined : await response.json()) as T;
    return { data, status: response.status, serverDate };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Online exam transport (existing endpoints and contracts; no new API)
// ---------------------------------------------------------------------------

export type OnlineExamOption = 'A' | 'B' | 'C' | 'D';

export interface OnlineExamStartData {
  attempt: { id: string; expires_at: string };
  questions: Array<{
    questionNumber: number;
    section: string;
    questionText: string;
    options: Record<OnlineExamOption, string>;
    points: number;
  }>;
  responses: Record<string, OnlineExamOption>;
}

export interface OnlineExamSubmitData {
  submittedAt?: unknown;
  score?: Record<string, unknown> | null;
  alreadyScored?: boolean;
}

export interface OnlineExamListData {
  exams: Array<Record<string, unknown> & { exam_code?: unknown; attempt?: Record<string, unknown> | null }>;
}

/** A submit attempt that has not answered after this long is treated as unconfirmed and may be retried. */
export const ONLINE_EXAM_SUBMIT_TIMEOUT_MS = 8_000;
const ONLINE_EXAM_SAVE_TIMEOUT_MS = 10_000;

export const onlineExamTransport = {
  start(examCode: string) {
    return apiRequestWithMeta<OnlineExamStartData>(`/api/online-exams/${encodeURIComponent(examCode)}/start`, { method: 'POST' });
  },
  saveAnswers(examCode: string, attemptId: string, responses: Record<string, OnlineExamOption>) {
    return apiRequestWithMeta<{ saved?: boolean; savedAt?: string }>(
      `/api/online-exams/${encodeURIComponent(examCode)}/attempt`,
      { method: 'PATCH', body: JSON.stringify({ attemptId, responses }) },
      ONLINE_EXAM_SAVE_TIMEOUT_MS,
    );
  },
  submitAnswers(examCode: string, attemptId: string, responses: Record<string, OnlineExamOption>) {
    return apiRequestWithMeta<OnlineExamSubmitData>(
      `/api/online-exams/${encodeURIComponent(examCode)}/submit`,
      { method: 'POST', body: JSON.stringify({ attemptId, responses }) },
      ONLINE_EXAM_SUBMIT_TIMEOUT_MS,
    );
  },
  /** Read-only list request: used to re-synchronize the clock and to check an attempt's state. */
  listExams() {
    return apiRequestWithMeta<OnlineExamListData>('/api/online-exams');
  },
};

export type OnlineExamTransport = typeof onlineExamTransport;
