export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

// A rejection proves only this attempt did not admit. It cannot disprove an
// earlier uncertain admission with the same identity (including after refresh).
// Retain 413 handling for pending requests rejected by the previous app build. A 500 can happen after native admission (e.g. rename failure),
// so it and transport/response failures must retain the original requestId.
export function isDefiniteRejection(error: unknown, previouslyUncertain = false): error is ApiError {
  return !previouslyUncertain && error instanceof ApiError && [400, 403, 404, 409, 413, 415].includes(error.status);
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? undefined : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!response.ok) {
    const value = await response.json().catch(() => ({}));
    throw new ApiError(response.status, value.error ?? `Request failed (${response.status}).`);
  }
  return response.json();
}
