import type { HttpClient, HttpRequest, HttpResponse } from "./http-client.js";
import { NvSpeechError } from "./errors.js";

/**
 * RetryHttpClient — Decorator pattern.
 *
 * Wraps any HttpClient and retries idempotent failures with exponential backoff.
 * Only retries `retryable` errors (rate_limit, server, network, timeout).
 *
 * Non-retryable errors (auth, bad_request, not_found) bubble up immediately.
 *
 * Defaults: 3 attempts, 250ms initial delay, 2x backoff, 5s cap, 0-500ms jitter.
 */
export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  jitterMs?: number;
  /** Optional predicate to skip retry even on retryable errors. */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, "shouldRetry" | "sleep">> & {
  shouldRetry?: RetryOptions["shouldRetry"];
  sleep: RetryOptions["sleep"];
} = {
  maxAttempts: 3,
  initialDelayMs: 250,
  maxDelayMs: 5_000,
  backoffMultiplier: 2,
  jitterMs: 250,
  sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
};

export class RetryHttpClient implements HttpClient {
  private readonly inner: HttpClient;
  private readonly opts: Required<Omit<RetryOptions, "shouldRetry" | "sleep">> & {
    shouldRetry?: RetryOptions["shouldRetry"];
    sleep: RetryOptions["sleep"];
  };

  constructor(inner: HttpClient, options: RetryOptions = {}) {
    this.inner = inner;
    this.opts = { ...DEFAULT_OPTIONS, ...options };
  }

  async send<T = unknown>(request: HttpRequest): Promise<HttpResponse<T>> {
    let lastError: unknown;
    const sleepFn: (ms: number) => Promise<void> = this.opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let attempt = 1; attempt <= this.opts.maxAttempts; attempt++) {
      try {
        return await this.inner.send<T>(request);
      } catch (err) {
        lastError = err;
        const isRetryable = err instanceof NvSpeechError && err.retryable;
        const customSaysNo = this.opts.shouldRetry ? !this.opts.shouldRetry(err, attempt) : false;
        if (!isRetryable || customSaysNo || attempt === this.opts.maxAttempts) {
          throw err;
        }
        const delay = this.computeDelay(attempt);
        await sleepFn(delay);
      }
    }
    // Unreachable — the loop above either returns or throws.
    throw lastError;
  }

  private computeDelay(attempt: number): number {
    const exp = Math.min(
      this.opts.maxDelayMs,
      this.opts.initialDelayMs * Math.pow(this.opts.backoffMultiplier, attempt - 1),
    );
    const jitter = Math.floor(Math.random() * this.opts.jitterMs);
    return exp + jitter;
  }
}
