/**
 * Hardcoded defaults — names, models, ranges.
 * Never secrets. Never user data.
 */

export const NVIDIA_PROVIDER_ID = "nvidia" as const;

export const NVIDIA_DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1" as const;

export const NVIDIA_DEFAULT_TTS_MODEL = "magpie-tts-multilingual" as const;
export const NVIDIA_DEFAULT_TTS_VOICE = "Magpie-Multilingual.EN-US.Aria" as const;
export const NVIDIA_DEFAULT_TTS_LANGUAGE = "en-US" as const;
export const NVIDIA_DEFAULT_TTS_SAMPLE_RATE = 22050 as const;

export const NVIDIA_DEFAULT_STT_MODEL = "parakeet-ctc-1.1b-en-multilingual" as const;

/** Magpie supports a small set of output formats. */
export const NVIDIA_TTS_AUDIO_FORMATS = ["wav", "mp3", "flac", "ogg", "opus"] as const;
export type NvidiaTtsAudioFormat = (typeof NVIDIA_TTS_AUDIO_FORMATS)[number];

/** Sample rates Magpie produces at. */
export const NVIDIA_TTS_SAMPLE_RATES = [8000, 16000, 22050, 24000, 44100, 48000] as const;
export type NvidiaTtsSampleRate = (typeof NVIDIA_TTS_SAMPLE_RATES)[number];
