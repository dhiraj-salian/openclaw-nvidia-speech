/**
 * Config types + narrow validators. Pure, no I/O.
 *
 * The plugin accepts a loose `unknown` shape from OpenClaw's `providerConfig`
 * and narrows it to a strict, immutable `NvidiaProviderConfig` for the rest
 * of the code to consume.
 */

import {
  NVIDIA_DEFAULT_BASE_URL,
  NVIDIA_DEFAULT_TTS_LANGUAGE,
  NVIDIA_DEFAULT_TTS_MODEL,
  NVIDIA_DEFAULT_TTS_SAMPLE_RATE,
  NVIDIA_DEFAULT_TTS_VOICE,
  NVIDIA_DEFAULT_STT_MODEL,
  NVIDIA_TTS_AUDIO_FORMATS,
  NVIDIA_TTS_SAMPLE_RATES,
  type NvidiaTtsAudioFormat,
  type NvidiaTtsSampleRate,
} from "./defaults.js";

/** The fully resolved, validated config the rest of the plugin uses. */
export interface NvidiaProviderConfig {
  /** Resolved API key (never logged, never returned to OpenClaw). */
  readonly apiKey: string;
  /** Base URL for the NVIDIA API. Defaults to integrate.api.nvidia.com/v1. */
  readonly baseUrl: string;
  /** TTS-specific overrides (always present; use defaults if not set). */
  readonly tts: {
    readonly model: string;
    readonly defaultVoice: string;
    readonly defaultLanguage: string;
    readonly defaultSampleRate: NvidiaTtsSampleRate;
    readonly defaultFormat: NvidiaTtsAudioFormat;
  };
  /** STT-specific overrides. */
  readonly stt: {
    readonly model: string;
    readonly defaultLanguage?: string;
  };
}

/** Loose shape OpenClaw hands us. Anything might be missing or wrong. */
export interface RawNvidiaConfig {
  apiKey?: unknown;
  baseUrl?: unknown;
  model?: unknown;
  voice?: unknown;
  language?: unknown;
  sampleRate?: unknown;
  format?: unknown;
  sttModel?: unknown;
  sttLanguage?: unknown;
  [key: string]: unknown;
}

// ---------- narrow validators ----------

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export function asNonEmptyString(v: unknown): string | undefined {
  return isNonEmptyString(v) ? v.trim() : undefined;
}

export function asFiniteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function asFiniteInteger(v: unknown): number | undefined {
  const n = asFiniteNumber(v);
  return n !== undefined && Number.isInteger(n) ? n : undefined;
}

export function asNvidiaAudioFormat(v: unknown): NvidiaTtsAudioFormat | undefined {
  if (typeof v !== "string") return undefined;
  const lower = v.toLowerCase();
  return (NVIDIA_TTS_AUDIO_FORMATS as readonly string[]).includes(lower)
    ? (lower as NvidiaTtsAudioFormat)
    : undefined;
}

export function asNvidiaSampleRate(v: unknown): NvidiaTtsSampleRate | undefined {
  const n = asFiniteInteger(v);
  if (n === undefined) return undefined;
  return (NVIDIA_TTS_SAMPLE_RATES as readonly number[]).includes(n)
    ? (n as NvidiaTtsSampleRate)
    : undefined;
}

/** Throws a readable error if a URL is invalid. */
export function assertValidHttpUrl(url: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RangeError(`${label} is not a valid URL: ${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RangeError(`${label} must be http(s); got ${parsed.protocol}`);
  }
}

/**
 * Normalize loose raw config into strict config. Applies defaults, validates
 * ranges, throws on invalid values.
 *
 * Does NOT resolve the API key — that's done by the caller via secret-resolver
 * so the secret never lives in the same code path as logging/printing.
 */
export function normalizeRawConfig(raw: unknown): Omit<NvidiaProviderConfig, "apiKey"> {
  const r = (raw ?? {}) as RawNvidiaConfig;

  const baseUrl = asNonEmptyString(r.baseUrl) ?? NVIDIA_DEFAULT_BASE_URL;
  assertValidHttpUrl(baseUrl, "nvidia.baseUrl");

  const ttsModel = asNonEmptyString(r.model) ?? NVIDIA_DEFAULT_TTS_MODEL;
  const ttsVoice = asNonEmptyString(r.voice) ?? NVIDIA_DEFAULT_TTS_VOICE;
  const ttsLang = asNonEmptyString(r.language) ?? NVIDIA_DEFAULT_TTS_LANGUAGE;
  const ttsSampleRate = asNvidiaSampleRate(r.sampleRate) ?? NVIDIA_DEFAULT_TTS_SAMPLE_RATE;
  const ttsFormat = asNvidiaAudioFormat(r.format) ?? "wav";

  const sttModel = asNonEmptyString(r.sttModel) ?? NVIDIA_DEFAULT_STT_MODEL;
  const sttLang = asNonEmptyString(r.sttLanguage);

  return {
    baseUrl,
    tts: {
      model: ttsModel,
      defaultVoice: ttsVoice,
      defaultLanguage: ttsLang,
      defaultSampleRate: ttsSampleRate,
      defaultFormat: ttsFormat,
    },
    stt: {
      model: sttModel,
      ...(sttLang ? { defaultLanguage: sttLang } : {}),
    },
  };
}
