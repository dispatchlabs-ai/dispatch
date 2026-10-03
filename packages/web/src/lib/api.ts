export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const contentType = response.headers.get("Content-Type") || "";
  if (!contentType.includes("application/json")) {
    throw new ApiError(response.status, "INVALID_RESPONSE", "The service returned an unexpected response. Try again in a moment.");
  }
  const data = await response.json();
  if (!response.ok) {
    throw new ApiError(response.status, data.error?.code || "REQUEST_FAILED", data.error?.message || "The request could not be completed.");
  }
  return data as T;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.name === "NotAllowedError") return "The passkey request was cancelled or could not be verified. Try again when you’re ready.";
  if (error instanceof Error && error.name === "InvalidStateError") return "This passkey is already registered. Try another passkey or sign in.";
  return "Couldn’t connect. Check your connection and try again.";
}
