import type { HttpClient, HttpRequest, HttpResponse } from "./http-client.js";

/**
 * FakeHttpClient — programmable test double.
 *
 * Usage:
 *   const fake = new FakeHttpClient();
 *   fake.queueResponse({ status: 200, body: { ok: true } });
 *   fake.queueResponse(new NvSpeechError("rate limited", { kind: "rate_limit", status: 429 }));
 *   const res = await client.send(...);
 *   expect(fake.calls).toHaveLength(1);
 *
 * If the queue runs dry, throws — fail loud, not silent.
 */
export class FakeHttpClient implements HttpClient {
  public readonly calls: HttpRequest[] = [];
  private readonly queue: Array<
    | { kind: "ok"; response: Omit<HttpResponse<unknown>, "headers"> & { headers?: Record<string, string> } }
    | { kind: "throw"; error: Error }
  > = [];

  public queueResponse(
    response:
      | (Omit<HttpResponse<unknown>, "headers"> & { headers?: Record<string, string> })
      | Error,
  ): void {
    if (response instanceof Error) {
      this.queue.push({ kind: "throw", error: response });
    } else {
      this.queue.push({ kind: "ok", response });
    }
  }

  public get pending(): number {
    return this.queue.length;
  }

  async send<T = unknown>(request: HttpRequest): Promise<HttpResponse<T>> {
    this.calls.push(request);
    const next = this.queue.shift();
    if (!next) {
      throw new Error(
        `FakeHttpClient: no queued response for ${request.method} ${request.url} ` +
          `(calls so far: ${this.calls.length})`,
      );
    }
    if (next.kind === "throw") throw next.error;
    const { headers = {}, requestId: explicitRequestId, ...rest } = next.response;
    const requestId =
      explicitRequestId ??
      Object.entries(headers).find(([k]) => k.toLowerCase() === "x-request-id")?.[1];
    const out: HttpResponse<T> = { ...rest, headers } as HttpResponse<T>;
    if (requestId !== undefined) (out as { requestId?: string }).requestId = requestId;
    return out;
  }
}
