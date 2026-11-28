// Loads one Institute Workspace API resource with real loading, error and reload states.
// No fallback or sample data: on failure the caller shows the error.
import { useCallback, useEffect, useState } from 'react';
import { apiRequest } from '../../api';

export type ResourceState<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'success'; data: T };

export function useWorkspaceResource<T>(path: string): { state: ResourceState<T>; reload: () => void } {
  const [state, setState] = useState<ResourceState<T>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    apiRequest<T>(path)
      .then((data) => { if (!cancelled) setState({ status: 'success', data }); })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: 'error', message: error instanceof Error ? error.message : 'The request could not be completed.' });
      });
    return () => { cancelled = true; };
  }, [path, attempt]);
  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  return { state, reload };
}

/** Sends a JSON write and returns the parsed answer, or throws ApiError with the server's message. */
export function sendWorkspaceWrite<T>(path: string, method: 'POST' | 'PATCH' | 'PUT', body: unknown): Promise<T> {
  return apiRequest<T>(path, { method, body: JSON.stringify(body) });
}
