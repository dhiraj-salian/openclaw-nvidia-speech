/**
 * HttpClient — the only network abstraction the rest of the plugin sees.
 *
 * Dependency Inversion: high-level providers depend on this interface,
 * not on `fetch`. Tests inject `FakeHttpClient`. Decorators like
 * `RetryHttpClient` wrap the concrete impl without changing it.
 *
 * Response shape is deliberately normalised so callers never have to
 * branch on `Response` vs `ArrayBuffer` vs `JSON.parse(text)` — the
 * HttpClient decides which based on the request `responseKind`.
 */

export type ResponseKind = "json" | "bytes" | "text";

export interface HttpRequest {
  /** Fully qualified URL. Caller composes (baseUrl + path). */
  readonly url: string;
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly headers: Readonly<Record<string, string>>;
  /**
   * Either a JSON-serialisable object (Content-Type set automatically),
   * a `Buffer` / `Uint8Array` / `string` for raw bodies, or a `FormData`.
   */
  readonly body?:
    | { readonly kind: "json"; readonly value: unknown }
    | { readonly kind: "bytes"; readonly value: Uint8Array | Buffer | string }
    | { readonly kind: "formData"; readonly value: FormData };
  readonly responseKind: ResponseKind;
  readonly timeoutMs?: number;
  /** Optional abort signal for callers to cancel (e.g. on plugin shutdown). */
  readonly signal?: AbortSignal;
}

export interface HttpResponse<T> {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: T;
  /** NVIDIA's request id, if present (`X-Request-Id` / `request-id`). */
  readonly requestId?: string;
}

export interface HttpClient {
  send<T = unknown>(request: HttpRequest): Promise<HttpResponse<T>>;
}

/** Small helper for clients — case-insensitive header lookup. */
export function headerValue(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return v;
  }
  return undefined;
}
