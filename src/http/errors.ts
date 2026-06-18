/**
 * Error hierarchy for NVIDIA speech clients.
 *
 * Strict typing: callers can `instanceof` to decide between retry, surface
 * to user, or convert to OpenClaw provider error.
 */

export type NvErrorKind =
  | "auth"
  | "rate_limit"
  | "bad_request"
  | "not_found"
  | "server"
  | "network"
  | "timeout"
  | "unknown";

/** Base error for everything this plugin throws. */
export class NvSpeechError extends Error {
  public readonly kind: NvErrorKind;
  public readonly status?: number;
  public readonly requestId?: string;
  public readonly providerPayload?: unknown;

  constructor(
    message: string,
    options: {
      kind: NvErrorKind;
      status?: number;
      requestId?: string;
      providerPayload?: unknown;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "NvSpeechError";
    this.kind = options.kind;
    if (options.status !== undefined) this.status = options.status;
    if (options.requestId !== undefined) this.requestId = options.requestId;
    if (options.providerPayload !== undefined) this.providerPayload = options.providerPayload;
  }

  /** True when retrying could succeed (rate limit, transient server, network). */
  public get retryable(): boolean {
    return (
      this.kind === "rate_limit" ||
      this.kind === "server" ||
      this.kind === "network" ||
      this.kind === "timeout"
    );
  }
}

/** Thrown when the HTTP request itself fails (DNS, connect refused, etc.). */
export class NvNetworkError extends NvSpeechError {
  constructor(message: string, cause?: unknown) {
    super(message, { kind: "network", cause });
    this.name = "NvNetworkError";
  }
}

/** Thrown when the request exceeds the timeout budget. */
export class NvTimeoutError extends NvSpeechError {
  constructor(message: string, cause?: unknown) {
    super(message, { kind: "timeout", cause });
    this.name = "NvTimeoutError";
  }
}
