/**
 * Resolve the NVIDIA API key from a clear priority chain.
 *
 * Priority:
 *   1. Explicit `apiKey` in provider config (may be a SecretRef-like object
 *      resolved by OpenClaw, or a plain string for unit tests / scripts).
 *   2. The named environment variable (default: NVIDIA_API_KEY).
 *   3. Throw — never fall back to empty string or undefined.
 *
 * The env var name is a PARAMETER, never a literal in this file's runtime
 * behaviour, so a linter can grep for hardcoded env-var reads elsewhere.
 *
 * CRITICAL: this function NEVER logs the resolved value, even at debug level.
 */

export interface ResolveApiKeyOptions {
  /** Config-time apiKey field; if present, takes priority over env. */
  readonly provided?: unknown;
  /** Env var name to read from process.env (default: NVIDIA_API_KEY). */
  readonly envVar?: string;
  /** Optional override for env (e.g. test fixture). */
  readonly env?: Record<string, string | undefined>;
}

export class MissingApiKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingApiKeyError";
  }
}

/** Coerce whatever OpenClaw passes as `apiKey` into a clean string. */
function coerceProvided(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (value && typeof value === "object" && "value" in value) {
    const inner = (value as { value: unknown }).value;
    if (typeof inner === "string" && inner.trim().length > 0) return inner.trim();
  }
  return undefined;
}

export function resolveApiKey(options: ResolveApiKeyOptions = {}): string {
  const envVar = options.envVar ?? "NVIDIA_API_KEY";
  const env = options.env ?? process.env;

  const provided = coerceProvided(options.provided);
  if (provided) return provided;

  const fromEnv = env[envVar];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }

  throw new MissingApiKeyError(
    `NVIDIA API key not found. Set the ${envVar} environment variable or ` +
      `provide apiKey in plugin config.`,
  );
}

/**
 * Sanitize a config object for logging/diagnostics: removes the apiKey field
 * entirely. Always log through this, never the raw config.
 */
export function redactConfig<T extends Record<string, unknown>>(config: T): Omit<T, "apiKey"> {
  const { apiKey: _apiKey, ...rest } = config;
  void _apiKey;
  return rest;
}
