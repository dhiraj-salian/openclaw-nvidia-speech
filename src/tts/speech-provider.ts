/**
 * SpeechProviderPlugin — the OpenClaw TTS contract for NVIDIA Magpie.
 *
 * Maps the OpenClaw `SpeechProviderPlugin` shape onto our existing
 * `NvidiaTtsClient` (raw HTTP) and `VoicesClient` (voice listing).
 *
 * This file is the boundary between OpenClaw's plugin runtime and the
 * domain logic. It is the ONLY place that imports both the OpenClaw
 * types (via shape conformance) and our internal clients.
 *
 * Design:
 *   - `createNvidiaSpeechProvider({ http, env })` is a pure factory; callers
 *     wire it in `index.ts` with `registerSpeechProvider(...)`.
 *   - `isConfigured` mirrors `resolveApiKey` logic but doesn't throw —
 *     just tells the runtime whether synthesis is possible.
 *   - `synthesize` merges `providerConfig` → `providerOverrides` → env,
 *     then delegates to `NvidiaTtsClient.synthesize`.
 *   - `parseDirectiveToken` accepts inline `voice:`/`model:`/`lang:`/`format:`
 *     overrides from message text (e.g. `[[tts:voice=Aria]]`).
 *   - `listVoices` proxies to `VoicesClient` with a 1h cache.
 */

import type { HttpClient } from "../http/http-client.js";
import {
  NVIDIA_DEFAULT_TTS_LANGUAGE,
  NVIDIA_DEFAULT_TTS_MODEL,
  NVIDIA_DEFAULT_TTS_SAMPLE_RATE,
  NVIDIA_DEFAULT_TTS_VOICE,
  NVIDIA_DEFAULT_BASE_URL_TTS,
  NVIDIA_TTS_AUDIO_FORMATS,
  NVIDIA_TTS_SAMPLE_RATES,
  type NvidiaTtsAudioFormat,
  type NvidiaTtsSampleRate,
} from "../config/defaults.js";
import {
  resolveApiKey,
  readApiKeyFromProfile,
  createCachedNvidiaApiKeyResolver,
  type CachedNvidiaApiKeyResolver,
  type NvidiaAuthProfileConfig,
  MissingApiKeyError,
  redactConfig,
} from "../utils/secret-resolver.js";
import { NvidiaTtsClient } from "./nvidia-tts-client.js";
import { VoicesClient } from "./voices.js";

/** Options for the factory. `env` is injectable for tests. */
export interface NvidiaSpeechProviderOptions {
  readonly http: HttpClient;
  readonly env?: Record<string, string | undefined>;
  /** Optional override for the env var name; defaults to NVIDIA_API_KEY. */
  readonly envVar?: string;
  /** Default timeout (ms) when caller doesn't specify one. */
  readonly defaultTimeoutMs?: number;
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

/** Overrides we accept from `providerConfig` + `providerOverrides`. */
interface ResolvedTtsCall {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly voice: string;
  readonly language: string;
  readonly sampleRate: NvidiaTtsSampleRate;
  readonly format: NvidiaTtsAudioFormat;
}

/**
 * Voice notes (e.g. WhatsApp) prefer mp3 at common sample rates.
 * wav at 8k-48k is also widely compatible.
 */
function isVoiceCompatible(format: string): boolean {
  const f = format.toLowerCase();
  if (f.includes("mpeg") || f.includes("mp3")) return true;
  if (f.includes("wav") || f.includes("x-wav")) return true;
  if (f.includes("ogg") || f.includes("opus")) return true;
  return false;
}

function coerceAudioFormat(v: unknown): NvidiaTtsAudioFormat | undefined {
  if (typeof v !== "string") return undefined;
  const lower = v.toLowerCase();
  return (NVIDIA_TTS_AUDIO_FORMATS as readonly string[]).includes(lower)
    ? (lower as NvidiaTtsAudioFormat)
    : undefined;
}

function coerceSampleRate(v: unknown): NvidiaTtsSampleRate | undefined {
  const n = typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) ? v : undefined;
  if (n === undefined) return undefined;
  return (NVIDIA_TTS_SAMPLE_RATES as readonly number[]).includes(n)
    ? (n as NvidiaTtsSampleRate)
    : undefined;
}

/**
 * Strip trailing slash. Used in URL composition.
 */
function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
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

export function createNvidiaSpeechProvider(
  options: NvidiaSpeechProviderOptions,
): NvidiaSpeechProvider {
  const envVar = options.envVar ?? "NVIDIA_API_KEY";
  const env = options.env ?? process.env;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  const profileReader = options.profileReader;

  const ttsClient = new NvidiaTtsClient(options.http);
  const voicesClient = new VoicesClient(options.http);

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
  // Kick off resolution eagerly so the first synthesize/listVoices call
  // (typically right after plugin load) hits a warm cache. Fire-and-forget;
  // any error is deferred to the next explicit `getApiKey()` call.
  if (process.env.NVIDIA_SPEECH_PLUGIN_DEBUG) {
    console.warn("[nvidia-speech] [tts] kicking off eager resolve...");
  }
  cachedKey()
    .then((v) => {
      if (process.env.NVIDIA_SPEECH_PLUGIN_DEBUG) {
        console.warn(
          `[nvidia-speech] [tts] eager resolveNvidiaApiKey succeeded, key length: ${v.length}`,
        );
      }
    })
    .catch((err) => {
      if (process.env.NVIDIA_SPEECH_PLUGIN_DEBUG) {
        console.warn(
          `[nvidia-speech] [tts] eager resolveNvidiaApiKey FAILED:`,
          err instanceof Error ? err.message : String(err),
          err instanceof Error ? err.stack : "",
        );
      }
    });
  if (process.env.NVIDIA_SPEECH_PLUGIN_DEBUG) {
    setTimeout(() => {
      const peeked = cachedKey.peek();
      console.warn(
        `[nvidia-speech] [tts] 500ms after register: peek = ${
          peeked ? `len=${peeked.length}` : "undefined"
        }`,
      );
    }, 500);
  }

  /**
   * Resolve the API key synchronously using the best-known source at call
   * time. Priority:
   *   1. Explicit `providerConfig.apiKey` (string or SecretRef-like).
   *   2. Cached value from the OpenClaw runtime auth-profile resolver.
   *   3. Legacy chain: env → shell-profile reader.
   */
  function getApiKey(providerConfig: Record<string, unknown> | undefined): string {
    const cfg = providerConfig ?? {};
    const provided = coerceProvidedApiKey(cfg.apiKey);
    if (provided) return provided;

    const cached = cachedKey.peek();
    if (cached) return cached;

    return resolveApiKey({
      envVar,
      env,
      ...(profileReader ? { profileReader } : {}),
    });
  }

  function resolveTtsCall(
    providerConfig: Record<string, unknown> | undefined,
    providerOverrides: Record<string, unknown> | undefined,
  ): ResolvedTtsCall {
    const cfg = providerConfig ?? {};
    const over = providerOverrides ?? {};

    // API key: explicit providerConfig.apiKey → cached auth-profile → env/profile.
    const apiKey = getApiKey(providerConfig);

    const baseUrl =
      (typeof cfg.baseUrl === "string" && cfg.baseUrl.trim()) || NVIDIA_DEFAULT_BASE_URL_TTS;

    const model =
      (typeof over.model === "string" && over.model.trim()) ||
      (typeof cfg.model === "string" && cfg.model.trim()) ||
      NVIDIA_DEFAULT_TTS_MODEL;

    const voice =
      (typeof over.voice === "string" && over.voice.trim()) ||
      (typeof cfg.voice === "string" && cfg.voice.trim()) ||
      NVIDIA_DEFAULT_TTS_VOICE;

    const language =
      (typeof over.language === "string" && over.language.trim()) ||
      (typeof cfg.language === "string" && cfg.language.trim()) ||
      NVIDIA_DEFAULT_TTS_LANGUAGE;

    const sampleRate =
      coerceSampleRate(over.sampleRate) ||
      coerceSampleRate(cfg.sampleRate) ||
      NVIDIA_DEFAULT_TTS_SAMPLE_RATE;

    const format =
      coerceAudioFormat(over.format) ||
      coerceAudioFormat(cfg.format) ||
      ("wav" as NvidiaTtsAudioFormat);

    return { apiKey, baseUrl, model, voice, language, sampleRate, format };
  }

  return {
    id: "nvidia",
    label: "NVIDIA Magpie Multilingual TTS",
    defaultModel: NVIDIA_DEFAULT_TTS_MODEL,
    defaultTimeoutMs,
    models: [NVIDIA_DEFAULT_TTS_MODEL] as const,

    isConfigured(ctx) {
      // Same precedence as synthesize, but non-throwing.
      const cfg = (ctx.providerConfig ?? {}) as Record<string, unknown>;
      if (coerceProvidedApiKey(cfg.apiKey)) return true;
      // Cached auth-profile value (already resolved).
      const cached = cachedKey.peek();
      if (cached) return true;
      const fromEnv = env[envVar];
      if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return true;
      // Last-resort: profile-fallback reader.
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

    async synthesize(req) {
      let call: ResolvedTtsCall;
      try {
        call = resolveTtsCall(req.providerConfig, req.providerOverrides);
      } catch (err) {
        if (err instanceof MissingApiKeyError) throw err;
        throw err;
      }

      const result = await ttsClient.synthesize({
        apiKey: call.apiKey,
        baseUrl: call.baseUrl,
        model: call.model,
        text: req.text,
        voiceName: call.voice,
        languageCode: call.language,
        audioFormat: call.format,
        sampleRateHz: call.sampleRate,
        timeoutMs: req.timeoutMs,
      });

      return {
        audioBuffer: Buffer.from(
          result.audio.buffer,
          result.audio.byteOffset,
          result.audio.byteLength,
        ),
        outputFormat: result.contentType,
        fileExtension: result.fileExtension,
        voiceCompatible: isVoiceCompatible(result.contentType),
      };
    },

    parseDirectiveToken(ctx) {
      const policy = ctx.policy;
      const warnings: string[] = [];
      const overrides: Record<string, unknown> = {};

      switch (ctx.key) {
        case "voice": {
          if (!policy.allowVoice) return { handled: false };
          if (typeof ctx.value !== "string" || ctx.value.trim().length === 0) {
            warnings.push("voice override must be a non-empty string");
            return { handled: false, warnings };
          }
          overrides.voice = ctx.value.trim();
          break;
        }
        case "model": {
          if (!policy.allowModelId) return { handled: false };
          if (typeof ctx.value !== "string" || ctx.value.trim().length === 0) {
            warnings.push("model override must be a non-empty string");
            return { handled: false, warnings };
          }
          overrides.model = ctx.value.trim();
          break;
        }
        case "lang":
        case "language": {
          if (!policy.allowVoice) return { handled: false };
          if (typeof ctx.value !== "string" || ctx.value.trim().length === 0) {
            warnings.push("language override must be a non-empty string");
            return { handled: false, warnings };
          }
          overrides.language = ctx.value.trim();
          break;
        }
        case "format": {
          if (!policy.allowVoiceSettings) return { handled: false };
          const fmt = coerceAudioFormat(ctx.value);
          if (!fmt) {
            warnings.push(
              `format override unsupported: ${JSON.stringify(ctx.value)} (supported: ${NVIDIA_TTS_AUDIO_FORMATS.join(", ")})`,
            );
            return { handled: false, warnings };
          }
          overrides.format = fmt;
          break;
        }
        case "sampleRate": {
          if (!policy.allowVoiceSettings) return { handled: false };
          const sr = coerceSampleRate(Number(ctx.value));
          if (!sr) {
            warnings.push(
              `sampleRate override unsupported: ${JSON.stringify(ctx.value)} (supported: ${NVIDIA_TTS_SAMPLE_RATES.join(", ")})`,
            );
            return { handled: false, warnings };
          }
          overrides.sampleRate = sr;
          break;
        }
        default:
          return { handled: false };
      }

      return { handled: true, overrides, warnings };
    },

    async listVoices(req) {
      // Pull config (apiKey + baseUrl) from providerConfig or direct overrides.
      const cfg = (req.providerConfig ?? {}) as Record<string, unknown>;
      let apiKey: string =
        coerceProvidedApiKey(cfg.apiKey) ||
        req.apiKey ||
        cachedKey.peek() ||
        (env[envVar] ?? "");

      // Profile fallback as last resort.
      if (!apiKey && profileReader) {
        const fromProfile = readApiKeyFromProfile({ ...profileReader, envVar });
        if (fromProfile) apiKey = fromProfile;
      }

      if (!apiKey) throw new MissingApiKeyError("No API key for voices listing");

      const baseUrl =
        (typeof req.baseUrl === "string" && req.baseUrl) ||
        (typeof cfg.baseUrl === "string" && cfg.baseUrl) ||
        NVIDIA_DEFAULT_BASE_URL_TTS;

      const voices = await voicesClient.listVoices({
        apiKey,
        baseUrl: stripTrailingSlash(baseUrl),
      });

      return voices.map((v) => {
        const out: {
          id: string;
          name?: string;
          locale?: string;
          gender?: string;
          description?: string;
        } = { id: v.id };
        if (v.name) out.name = v.name;
        if (v.language) out.locale = v.language;
        if (v.gender) out.gender = v.gender;
        if (v.description) out.description = v.description;
        return out;
      });
    },
  };
}

/**
 * The SpeechProviderPlugin shape — typed loosely so we don't need to import
 * OpenClaw's internal types (which would force a build-time dependency on
 * the SDK). The runtime contract is shape-conformant.
 *
 * Kept as a local interface so `index.ts` can wrap it with a thin
 * `definePluginEntry` shim in Task 12 without changing this file.
 */
export interface NvidiaSpeechProvider {
  readonly id: "nvidia";
  readonly label: string;
  readonly defaultModel: string;
  readonly defaultTimeoutMs: number;
  readonly models: readonly string[];
  isConfigured(ctx: {
    providerConfig: Record<string, unknown>;
    timeoutMs: number;
  }): boolean;
  synthesize(req: {
    text: string;
    cfg: unknown;
    providerConfig: Record<string, unknown>;
    target: { kind: string; [k: string]: unknown };
    providerOverrides?: Record<string, unknown>;
    timeoutMs: number;
  }): Promise<{
    audioBuffer: Buffer;
    outputFormat: string;
    fileExtension: string;
    voiceCompatible: boolean;
  }>;
  parseDirectiveToken?(ctx: {
    key: string;
    value: string;
    policy: {
      enabled: boolean;
      allowText: boolean;
      allowProvider: boolean;
      allowVoice: boolean;
      allowModelId: boolean;
      allowVoiceSettings: boolean;
      allowNormalization: boolean;
      allowSeed: boolean;
    };
    selectedProvider?: string;
    providerConfig?: Record<string, unknown>;
    currentOverrides?: Record<string, unknown>;
  }): {
    handled: boolean;
    overrides?: Record<string, unknown>;
    warnings?: string[];
  };
  listVoices?(req: {
    cfg?: unknown;
    providerConfig?: Record<string, unknown>;
    apiKey?: string;
    baseUrl?: string;
  }): Promise<
    Array<{
      id: string;
      name?: string;
      locale?: string;
      gender?: string;
      description?: string;
    }>
  >;
}

// Exported so index.ts can keep references for tests.
export { redactConfig };
