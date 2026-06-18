import { NvSpeechError, NvNetworkError, NvTimeoutError } from "./errors.js";
import type { HttpClient, HttpRequest, HttpResponse } from "./http-client.js";
import { headerValue } from "./http-client.js";

/**
 * FetchHttpClient — Node's built-in fetch wrapped behind our HttpClient
 * interface. Handles:
 *   - JSON / bytes / text bodies
 *   - FormData (lets fetch set Content-Type with boundary automatically)
 *   - Timeout via AbortController
 *   - Non-2xx → NvSpeechError with the right `kind` so callers / decorators
 *     can decide whether to retry.
 *
 * Does NOT retry. Wrap with RetryHttpClient if you want retries.
 */
export class FetchHttpClient implements HttpClient {
  private readonly fetchFn: typeof fetch;

  constructor(options?: { fetchFn?: typeof fetch }) {
    this.fetchFn = options?.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  async send<T = unknown>(request: HttpRequest): Promise<HttpResponse<T>> {
    const { url, method, headers, body, responseKind, timeoutMs, signal } = request;

    const headersOut: Record<string, string> = { ...headers };
    const init: RequestInit = { method, headers: headersOut };

    // Compose AbortController: external signal OR timeout OR both.
    let timedOut = false;
    const ctrl = new AbortController();
    if (signal) {
      if (signal.aborted) ctrl.abort(signal.reason);
      else signal.addEventListener("abort", () => ctrl.abort(signal.reason), { once: true });
    }
    let timer: NodeJS.Timeout | undefined;
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        ctrl.abort(new Error("timed out"));
      }, timeoutMs);
      timer.unref?.();
    }
    init.signal = ctrl.signal;

    if (body) {
      if (body.kind === "json") {
        headersOut["Content-Type"] = "application/json";
        init.body = JSON.stringify(body.value);
      } else if (body.kind === "bytes") {
        const bytes = body.value;
        if (typeof bytes === "string") {
          init.body = new TextEncoder().encode(bytes);
        } else {
          // Always copy into a fresh Uint8Array (BodyInit-friendly, never alias).
          init.body = new Uint8Array(bytes);
        }
      } else {
        // formData: let fetch set Content-Type with boundary.
        init.body = body.value;
      }
    }

    let response: Response;
    try {
      response = await this.fetchFn(url, init);
    } catch (err) {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        throw new NvTimeoutError(`request timed out after ${timeoutMs}ms`, err);
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new NvNetworkError(`network failure: ${message}`, err);
    }
    if (timer) clearTimeout(timer);

    // Capture headers (lowercase keys for case-insensitive lookup).
    const respHeaders: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      respHeaders[k.toLowerCase()] = v;
    });

    const requestId = headerValue(respHeaders, "x-request-id");

    if (!response.ok) {
      // Try to read the error body for context. Best-effort; ignore failures.
      let providerPayload: unknown = undefined;
      let detail = `HTTP ${response.status}`;
      try {
        const text = await response.text();
        if (text) {
          try {
            providerPayload = JSON.parse(text);
          } catch {
            providerPayload = text;
          }
          detail = `${detail}: ${text.slice(0, 500)}`;
        }
      } catch {
        // ignore
      }
      throw new NvSpeechError(detail, {
        kind: classifyStatus(response.status),
        status: response.status,
        ...(requestId !== undefined ? { requestId } : {}),
        providerPayload,
      });
    }

    const parsedBody = await parseBody<T>(response, responseKind);

    return {
      status: response.status,
      headers: respHeaders,
      body: parsedBody,
      ...(requestId !== undefined ? { requestId } : {}),
    };
  }
}

function classifyStatus(status: number): NvSpeechError["kind"] {
  if (status === 401 || status === 403) return "auth";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate_limit";
  if (status === 404) return "not_found";
  if (status === 400 || status === 422) return "bad_request";
  if (status >= 500) return "server";
  return "unknown";
}

async function parseBody<T>(response: Response, kind: HttpRequest["responseKind"]): Promise<T> {
  if (kind === "bytes") {
    const buf = await response.arrayBuffer();
    return new Uint8Array(buf) as unknown as T;
  }
  if (kind === "text") {
    return (await response.text()) as unknown as T;
  }
  // json
  const ct = response.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    return (await response.json()) as T;
  }
  // Fallback: try JSON.parse on text; if fails, return as string so caller sees
  // what the server actually said.
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}
