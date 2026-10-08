/** Only use for fixed, safe diagnostics: never include credentials or remote response bodies. */
export class WebBackendError extends Error {}

/** Retrieval boundary: implementations enforce URL/network safety and honor cancellation. */
export interface WebBackend {
  search(query: { q: string; recency?: number; domains?: string[] }, signal?: AbortSignal): Promise<Array<{
    url: string;
    title: string;
    snippet: string;
  }>>;
  open(url: string, signal?: AbortSignal): Promise<{
    url: string;
    title: string;
    text: string;
    links: Array<{ url: string; text: string }>;
    truncated?: boolean;
  }>;
}
