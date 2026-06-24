/**
 * MediaUnderstandingProvider shape — the OpenClaw STT contract for NVIDIA Parakeet.
 *
 * Maps the OpenClaw `AudioTranscriptionRequest` onto our internal `NvidiaSttClient`.
 *
 * This is the boundary between OpenClaw's plugin runtime and our domain logic.
 *
 * Design:
 *   - `createNvidiaMediaUnderstandingProvider({ http, env })` is a pure factory;
 *     callers wire it in `index.ts` with `registerMediaUnderstandingProvider(...)`.
 *   - The provider advertises ONLY `audio` (Parakeet is STT-only).
 *     Image / video capabilities are out of scope.
 *   - `defaultModels.audio` matches `NVIDIA_DEFAULT_STT_MODEL` and is also
 *     advertised via `openclaw.plugin.json`'s `mediaUnderstandingProviderMetadata`
 *     so the runtime's auto-priority + model picker sees it.
 *   - `autoPriority.audio` is `50` (same tier as ElevenLabs at 45 — higher means
 *     tried sooner). NVIDIA is a strong general-purpose default for users who
 *     already have the key configured.
 */

import type { HttpClient } from "../http/http-client.js";
import {
  NVIDIA_DEFAULT_BASE_URL_STT,
  NVIDIA_DEFAULT_STT_LANGUAGE,
  NVIDIA_DEFAULT_STT_MODEL,
} from "../config/defaults.js";
import {
  resolveApiKey,
  readApiKeyFromProfile,
  createCachedNvidiaApiKeyResolver,
  type CachedNvidiaApiKeyResolver,
  type NvidiaAuthProfileConfig,
  MissingApiKeyError,
} from "../utils/secret-resolver.js";
import { NvidiaSttClient } from "./nvidia-stt-client.js";

export interface NvidiaMediaProviderOptions {
  readonly http: HttpClient;
  /** Optional env override for tests. Defaults to `process.env`. */
  readonly env?: Record<string, string | undefined>;
  /** Optional override for the env var name; defaults to NVIDIA_API_KEY. */
  readonly envVar?: string;
  /** Default timeout (ms) when caller doesn't specify one. */
  readonly defaultTimeoutMs?: number;
  /**
   * Optional override of the default STT model. Mostly for tests / per-agent
   * customisation; in production we always want NVIDIA_DEFAULT_STT_MODEL.
   */
  readonly defaultModel?: string;
  /**
   * Optional profile-fallback reader. When supplied, the provider will
   * scan the user's shell profile files (`.bashrc`, `.zshrc`, …) for a
   * `NVIDIA_API_KEY=…` export as a last-resort fallback. Mirrors the
   * bundled `elevenlabs` plugin's `resolveElevenLabsApiKeyWithProfileFallback`
   * pattern. Omit to disable profile fallback (legacy behaviour).
   */
  readonly profileReader?: import("../utils/secret-resolver.js").ProfileReader;
  /**
   * Optional OpenClaw config (`api.config` from `register(api)`). When
   * present, the provider resolves the API key via the runtime auth
   * profile store (same source the bundled `nvidia` chat provider uses),
   * so a single configured key serves both. Falls back to the legacy
   * chain if the runtime resolver isn't available or returns nothing.
   */
  readonly cfg?: NvidiaAuthProfileConfig | undefined;
  /**
   * Optional agent dir for scoped auth-profile lookups (multi-agent
   * setups). Defaults to undefined (global profile store).
   */
  readonly agentDir?: string;
}

/**
 * Loose shape of what OpenClaw passes via the `providerConfig` field
 * (resolved by OpenClaw's secret-ref chain before reaching us).
 */
interface LooseProviderConfig {
  readonly apiKey?: unknown;
  readonly baseUrl?: unknown;
  readonly sttModel?: unknown;
  readonly sttLanguage?: unknown;
  readonly model?: unknown; // fallback for `sttModel`
  readonly language?: unknown; // fallback for `sttLanguage`
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

/**
 * Coerce whatever OpenClaw passes as `apiKey` into a clean string.
 * Accepts a raw string or a SecretRef-like `{ value }` object. Returns
 * undefined when the input is missing, empty, or the wrong shape.
 */
function coerceProvidedApiKey(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (value && typeof value === "object" && "value" in value) {
    const inner = (value as { value: unknown }).value;
    if (typeof inner === "string" && inner.trim().length > 0) return inner.trim();
  }
  return undefined;
}

export function createNvidiaMediaUnderstandingProvider(
  options: NvidiaMediaProviderOptions,
): NvidiaMediaUnderstandingProvider {
  const envVar = options.envVar ?? "NVIDIA_API_KEY";
  const env = options.env ?? process.env;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  const defaultModel = options.defaultModel ?? NVIDIA_DEFAULT_STT_MODEL;
  const profileReader = options.profileReader;

  const sttClient = new NvidiaSttClient(options.http);

  // Memoised async resolver — first call hits the OpenClaw runtime
  // auth-profile store (same source the bundled `nvidia` chat provider
  // uses), subsequent calls hit cache. Falls back to the legacy chain
  // (env / shell profile) on failure or when no `cfg` is wired.
  const cachedKey: CachedNvidiaApiKeyResolver = createCachedNvidiaApiKeyResolver({
    envVar,
    env,
    ...(profileReader ? { profileReader } : {}),
    ...(options.cfg ? { cfg: options.cfg } : {}),
    ...(options.agentDir ? { agentDir: options.agentDir } : {}),
  });
  // Kick off resolution eagerly so the first transcribeAudio call
  // (typically right after plugin load) hits a warm cache.
  if (process.env.NVIDIA_SPEECH_PLUGIN_DEBUG) {
    console.warn("[nvidia-speech] [stt] kicking off eager resolve...");
  }
  cachedKey()
    .then((v) => {
      if (process.env.NVIDIA_SPEECH_PLUGIN_DEBUG) {
        console.warn(
          `[nvidia-speech] [stt] eager resolveNvidiaApiKey succeeded, key length: ${v.length}`,
        );
      }
    })
    .catch((err) => {
      if (process.env.NVIDIA_SPEECH_PLUGIN_DEBUG) {
        console.warn(
          `[nvidia-speech] [stt] eager resolveNvidiaApiKey FAILED:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    });
  if (process.env.NVIDIA_SPEECH_PLUGIN_DEBUG) {
    setTimeout(() => {
      const peeked = cachedKey.peek();
      console.warn(
        `[nvidia-speech] [stt] 500ms after register: peek = ${
          peeked ? `len=${peeked.length}` : "undefined"
        }`,
      );
    }, 500);
  }

  /**
   * Resolve the API key, preferring the cached auth-profile value but
   * gracefully awaiting the in-flight async resolve on cache miss.
   *
   * Priority:
   *   1. `req.apiKey` (caller-provided direct key, e.g. from request auth).
   *   2. Explicit `providerConfig.apiKey` (string or SecretRef-like).
   *   3. Cached value from the OpenClaw runtime auth-profile resolver
   *      (sync peek first).
   *   4. Await the in-flight or fresh cached resolver — covers the
   *      "first call after register() returns" race where eager resolve
   *      hasn't completed yet. This is the bug fix for
   *      https://github.com/dhiraj-salian/openclaw-nvidia-speech/issues/race-stt-key.
   *   5. Legacy chain: env → shell-profile reader.
   *
   * Returns a Promise. Throws `MissingApiKeyError` only when ALL sources
   * are empty.
   */
  async function getApiKey(
    reqApiKey: string | undefined,
    providerConfig: Record<string, unknown> | undefined,
  ): Promise<string> {
    if (typeof reqApiKey === "string" && reqApiKey.trim().length > 0) {
      return reqApiKey.trim();
    }
    const cfg = providerConfig ?? {};
    const provided = coerceProvidedApiKey(cfg.apiKey);
    if (provided) return provided;
    // Sync peek first — common case once the eager resolve has finished.
    const cached = cachedKey.peek();
    if (cached) return cached;
    // Cache cold path: await the resolver. If `cfg` was wired into the
    // factory, this hits the OpenClaw auth-profile store. If not, it
    // falls through to the legacy env/profile chain via `resolveNvidiaApiKey`.
    try {
      return await cachedKey();
    } catch {
      // Re-throw the resolver's own MissingApiKeyError; otherwise fall
      // through to the legacy chain as a last-resort attempt.
    }
    return resolveApiKey({
      envVar,
      env,
      ...(profileReader ? { profileReader } : {}),
    });
  }

  return {
    id: "nvidia",
    capabilities: ["audio"],
    defaultModels: { audio: defaultModel },
    autoPriority: { audio: 50 },

    /**
     * Synchronous configuration probe — mirrors the TTS provider's
     * `isConfigured` so the OpenClaw runtime can pick this provider
     * during `isCapabilityProviderConfigured` / auto-fallback selection.
     *
     * Returns true when ANY of the following is configured:
     *   - providerConfig.apiKey (explicit)
     *   - cached auth-profile resolve (peek — non-blocking)
     *   - process.env[envVar]
     *   - shell profile fallback (best-effort sync read)
     *
     * If the auth-profile resolve is still in flight (first call after
     * register), this returns false; the runtime will re-probe on the
     * next capability lookup, by which time the cache should be warm.
     */
    isConfigured(ctx?: {
      cfg?: Record<string, unknown>;
      agentDir?: string;
      providerConfig?: Record<string, unknown>;
    }): boolean {
      const cfg = (ctx?.providerConfig ?? {}) as Record<string, unknown>;
      if (coerceProvidedApiKey(cfg.apiKey)) return true;
      const cached = cachedKey.peek();
      if (cached) return true;
      const fromEnv = env[envVar];
      if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return true;
      if (profileReader) {
        try {
          const fromProfile = readApiKeyFromProfile({ ...profileReader, envVar });
          return typeof fromProfile === "string" && fromProfile.length > 0;
        } catch {
          return false;
        }
      }
      return false;
    },

    async transcribeAudio(req) {
      // Resolve API key. Await the resolver so cache-cold calls (first
      // request right after register) don't fall through to the legacy
      // chain and throw MissingApiKeyError before the eager resolve
      // finishes.
      const apiKey = await getApiKey(req.apiKey, req.providerConfig);

      // Pull config from the standard `providerConfig` loose shape. The
      // runtime passes it via `req.request?.headers` / `req.auth`, but for
      // plugin-installed providers the config also travels via the per-
      // provider config lookup, which we already expose through req.baseUrl.
      const cfg = (req.providerConfig ?? {}) as LooseProviderConfig;

      const baseUrl =
        (typeof req.baseUrl === "string" && req.baseUrl.trim()) ||
        (typeof cfg.baseUrl === "string" && cfg.baseUrl) ||
        NVIDIA_DEFAULT_BASE_URL_STT;

      const model =
        asNonEmptyString(req.model) ||
        asNonEmptyString(cfg.sttModel) ||
        asNonEmptyString(cfg.model) ||
        defaultModel;

      // Language is REQUIRED for the NVCF Parakeet endpoint. Fall back to
      // the configured default (en-US) if nothing else is supplied, so
      // callers that don't set language still get a useful result.
      const language =
        asNonEmptyString(req.language) ||
        asNonEmptyString(cfg.sttLanguage) ||
        asNonEmptyString(cfg.language) ||
        NVIDIA_DEFAULT_STT_LANGUAGE;

      const result = await sttClient.transcribe({
        apiKey,
        baseUrl: stripTrailingSlash(baseUrl),
        model,
        audio: req.buffer,
        fileName: req.fileName,
        mime: req.mime ?? "application/octet-stream",
        ...(language ? { language } : {}),
        ...(req.prompt ? { prompt: req.prompt } : {}),
        // Falsy timeoutMs → use default. This catches both `undefined`
        // (callers that don't supply it) and `0` (zero is never a useful
        // timeout for an HTTP request).
        timeoutMs: req.timeoutMs > 0 ? req.timeoutMs : defaultTimeoutMs,
      });

      return {
        text: result.text,
        model: result.model,
        language,
      };
    },
  };
}

/**
 * Re-exported so callers can `instanceof` for granular error handling.
 */
export { MissingApiKeyError };

/**
 * The MediaUnderstandingProviderPlugin shape — typed loosely so we don't
 * need to import OpenClaw's internal types (which would force a build-time
 * dependency on the SDK). The runtime contract is shape-conformant.
 *
 * Mirrors `MediaUnderstandingProvider` from OpenClaw's plugin types:
 * https://github.com/openclaw/openclaw/blob/main/src/plugin-entry/types.ts
 */
export interface NvidiaMediaUnderstandingProvider {
  readonly id: "nvidia";
  readonly capabilities: readonly ["audio"];
  readonly defaultModels: { readonly audio: string };
  readonly autoPriority: { readonly audio: number };
  /**
   * Synchronous configuration probe. Used by the runtime's
   * `isCapabilityProviderConfigured` / auto-fallback selector. Must be
   * sync — see media-provider.ts `isConfigured` for details.
   */
  isConfigured(ctx?: {
    readonly cfg?: Record<string, unknown>;
    readonly agentDir?: string;
    readonly providerConfig?: Record<string, unknown>;
  }): boolean;
  transcribeAudio(req: {
    readonly buffer: Buffer;
    readonly fileName: string;
    readonly mime?: string;
    /** Direct API key — preferred when supplied. */
    readonly apiKey: string;
    /** Optional base URL override. */
    readonly baseUrl?: string;
    /** Optional model override. */
    readonly model?: string;
    /** Optional language hint (e.g. "en"). */
    readonly language?: string;
    /** Optional natural-language prompt. */
    readonly prompt?: string;
    /** Per-call timeout (ms). */
    readonly timeoutMs: number;
    /** Loose providerConfig for this provider (apiKey/baseUrl/etc.). */
    readonly providerConfig?: Record<string, unknown>;
  }): Promise<{ text: string; model?: string; language?: string }>;
}
