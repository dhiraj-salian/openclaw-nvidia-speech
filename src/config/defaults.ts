/**
 * Hardcoded defaults — names, models, ranges.
 * Never secrets. Never user data.
 *
 * NVIDIA's audio APIs live on the NVCF (NVIDIA Cloud Functions) platform,
 * NOT on `integrate.api.nvidia.com`. Each model has its own function ID
 * and lives at `{functionId}.invocation.api.nvcf.nvidia.com`. The base URL
 * here is an NVCF function URL already; the client appends `/audio/synthesize`
 * or `/audio/transcriptions`.
 */

export const NVIDIA_PROVIDER_ID = "nvidia" as const;

/**
 * NVCF function-host template. The plugin resolves a function ID for the
 * selected model and substitutes it into `{functionId}`. Both TTS and STT
 * currently use this same host (with different function IDs and paths).
 */
export const NVIDIA_NVCF_INVOCATION_BASE =
  "https://{functionId}.invocation.api.nvcf.nvidia.com/v1" as const;

/** Magpie TTS Multilingual — nvidia/magpie-tts-multilingual on build.nvidia.com. */
export const NVIDIA_MAGPIE_FUNCTION_ID = "877104f7-e885-42b9-8de8-f6e4c6303969" as const;
export const NVIDIA_DEFAULT_BASE_URL_TTS =
  `https://${NVIDIA_MAGPIE_FUNCTION_ID}.invocation.api.nvcf.nvidia.com/v1` as const;

/** Parakeet CTC 1.1B English — nvidia/parakeet-ctc-1_1b-asr on build.nvidia.com. */
export const NVIDIA_PARAKEET_FUNCTION_ID = "1598d209-5e27-4d3c-8079-4751568b1081" as const;
export const NVIDIA_DEFAULT_BASE_URL_STT =
  `https://${NVIDIA_PARAKEET_FUNCTION_ID}.invocation.api.nvcf.nvidia.com/v1` as const;

/**
 * Legacy alias kept for back-compat with existing plugin configs and tests
 * that referenced the old `integrate.api.nvidia.com/v1` base. New code
 * should use the TTS/STT base URLs above.
 */
export const NVIDIA_DEFAULT_BASE_URL = NVIDIA_DEFAULT_BASE_URL_TTS;

export const NVIDIA_DEFAULT_TTS_MODEL = "magpie-tts-multilingual" as const;
export const NVIDIA_DEFAULT_TTS_VOICE = "Magpie-Multilingual.EN-US.Aria" as const;
export const NVIDIA_DEFAULT_TTS_LANGUAGE = "en-US" as const;
export const NVIDIA_DEFAULT_TTS_SAMPLE_RATE = 22050 as const;

export const NVIDIA_DEFAULT_STT_MODEL = "parakeet-ctc-1.1b-en-us" as const;
/**
 * Default STT language. The English-only Parakeet NVCF function (function ID
 * `1598d209-…`) currently ONLY supports `en-US` — every other BCP-47 tag
 * returns HTTP 400 "Model not found for language <x>". When/if NVIDIA
 * exposes a multilingual Parakeet function ID, we'll route on language
 * to pick the right one.
 */
export const NVIDIA_DEFAULT_STT_LANGUAGE = "en-US" as const;

/** Output formats the Magpie endpoint supports (matches `Accept`/form `format`). */
export const NVIDIA_TTS_AUDIO_FORMATS = ["wav", "mp3", "flac", "ogg", "opus"] as const;
export type NvidiaTtsAudioFormat = (typeof NVIDIA_TTS_AUDIO_FORMATS)[number];

/** Sample rates Magpie produces at. */
export const NVIDIA_TTS_SAMPLE_RATES = [8000, 16000, 22050, 24000, 44100, 48000] as const;
export type NvidiaTtsSampleRate = (typeof NVIDIA_TTS_SAMPLE_RATES)[number];

/**
 * Languages the Magpie TTS endpoint accepts (verified live 2026-06-23 by
 * inspecting `/openapi.json` and probing each value). STT is English-only
 * — see `NVIDIA_DEFAULT_STT_LANGUAGE` for the single supported tag.
 */
export const NVIDIA_SUPPORTED_LANGUAGES = [
  "en-US",
  "en-GB",
  "es-ES",
  "es-MX",
  "fr-FR",
  "de-DE",
  "it-IT",
  "pt-BR",
  "zh-CN",
  "ja-JP",
  "hi-IN",
  "vi-VN",
] as const;
export type NvidiaLanguage = (typeof NVIDIA_SUPPORTED_LANGUAGES)[number];
