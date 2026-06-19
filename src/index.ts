/**
 * @dhiraj-salian/openclaw-nvidia-speech
 *
 * Adds NVIDIA TTS (Magpie Multilingual) and STT (Parakeet CTC) capabilities
 * to OpenClaw using only the user's NVIDIA_API_KEY.
 *
 * Public surface (for users importing this from JS/TS, not via OpenClaw):
 *   - `default` — the plugin entry (consumed by OpenClaw's plugin loader)
 *   - `createNvidiaSpeechProvider` — TTS factory for advanced integrators
 *   - `createNvidiaMediaUnderstandingProvider` — STT factory for advanced integrators
 *   - `FetchHttpClient` — Node fetch implementation (override for tests / proxies)
 *   - `RetryHttpClient` — exponential-backoff decorator
 *
 * For the normal "just install the plugin" path, OpenClaw reads
 * `openclaw.plugin.json` and calls `register(api)` itself.
 */

import { FetchHttpClient } from "./http/fetch-http-client.js";
import { RetryHttpClient } from "./http/retry-http-client.js";
import { createNvidiaSpeechProvider } from "./tts/speech-provider.js";
import { createNvidiaMediaUnderstandingProvider } from "./stt/media-provider.js";
import { buildDefaultProfileReader } from "./utils/secret-resolver.js";
import type { HttpClient } from "./http/http-client.js";

// Re-exports for advanced integrators / tests.
export { createNvidiaSpeechProvider } from "./tts/speech-provider.js";
export { createNvidiaMediaUnderstandingProvider } from "./stt/media-provider.js";
export { FetchHttpClient } from "./http/fetch-http-client.js";
export { RetryHttpClient } from "./http/retry-http-client.js";
export {
  NvSpeechError,
  NvNetworkError,
  NvTimeoutError,
  type NvErrorKind,
} from "./http/errors.js";
export {
  MissingApiKeyError,
  readApiKeyFromProfile,
  buildDefaultProfileReader,
  PROFILE_CANDIDATES,
  type ProfileReader,
  type ProfileReaderFs,
  type ProfileReaderOs,
} from "./utils/secret-resolver.js";
export {
  NVIDIA_DEFAULT_BASE_URL,
  NVIDIA_DEFAULT_TTS_MODEL,
  NVIDIA_DEFAULT_TTS_VOICE,
  NVIDIA_DEFAULT_TTS_LANGUAGE,
  NVIDIA_DEFAULT_TTS_SAMPLE_RATE,
  NVIDIA_DEFAULT_STT_MODEL,
  NVIDIA_TTS_AUDIO_FORMATS,
  NVIDIA_TTS_SAMPLE_RATES,
  type NvidiaTtsAudioFormat,
  type NvidiaTtsSampleRate,
} from "./config/defaults.js";

/**
 * The OpenClaw plugin entry shape.
 *
 * OpenClaw's plugin loader (`plugin-entry.ts` in the bundled runtime)
 * exports a `definePluginEntry({ id, name, description, register })`
 * helper that builds this object for us. We match its shape locally so we
 * don't take a build-time dependency on the SDK package — `openclaw/*`
 * stays external in the build.
 *
 * The runtime contract is shape-conformant; OpenClaw's loader will accept
 * any object that has `{ id, register(api) }`.
 */
export interface OpenClawPluginEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly register: (api: OpenClawPluginApi) => void | Promise<void>;
}

/**
 * Minimal slice of the OpenClawPluginApi we actually use.
 *
 * Typed loosely (the SDK's full type would force a build-time dep on
 * `openclaw/*` packages). OpenClaw passes a richer object at runtime.
 */
export interface OpenClawPluginApi {
  readonly registerSpeechProvider?: (provider: unknown) => void;
  readonly registerMediaUnderstandingProvider?: (provider: unknown) => void;
  readonly logger?: {
    readonly info?: (msg: string) => void;
    readonly warn?: (msg: string) => void;
    readonly error?: (msg: string, err?: unknown) => void;
    readonly debug?: (msg: string) => void;
  };
  readonly config?: Record<string, unknown>;
}

/**
 * Lightweight definePluginEntry shim — mirrors OpenClaw's runtime helper
 * closely enough that `register(api)` is the only thing host code touches.
 */
export function definePluginEntry(
  spec: OpenClawPluginEntry,
): OpenClawPluginEntry {
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    register: spec.register,
  };
}

/**
 * Default HTTP chain: Fetch → Retry(3 attempts on retryable errors).
 *
 * Tests inject a FakeHttpClient via the create*Provider factories; this
 * chain is the production runtime path. Retry only fires for `retryable`
 * NvSpeechError kinds (rate_limit, server, network, timeout).
 */
function buildDefaultHttp(): HttpClient {
  return new RetryHttpClient(new FetchHttpClient(), {
    maxAttempts: 3,
    initialDelayMs: 500,
    maxDelayMs: 8_000,
    backoffMultiplier: 2,
    jitterMs: 250,
  });
}

/**
 * Default profile reader — scans $HOME/.profile, .zprofile, .zshrc, .bashrc
 * for `NVIDIA_API_KEY=…`. Wired into both providers below so users who
 * keep the key in their shell profile don't need to duplicate it in
 * `openclaw.json` or `process.env`. Matches the bundled elevenlabs plugin's
 * `resolveElevenLabsApiKeyWithProfileFallback` pattern.
 */
const defaultProfileReader = buildDefaultProfileReader();

const plugin: OpenClawPluginEntry = definePluginEntry({
  id: "nvidia-speech",
  name: "NVIDIA Speech (TTS + STT)",
  description:
    "Adds NVIDIA TTS (Magpie Multilingual) and STT (Parakeet CTC) providers " +
    "to OpenClaw using only your NVIDIA_API_KEY. No Google, no OpenAI, no " +
    "Deepgram required.",
  register(api) {
    const http = buildDefaultHttp();

    // TTS — speechProvider id `nvidia` (per openclaw.plugin.json contracts).
    api.registerSpeechProvider?.(
      createNvidiaSpeechProvider({ http, profileReader: defaultProfileReader }),
    );

    // STT — mediaUnderstandingProvider id `nvidia` (per contracts).
    api.registerMediaUnderstandingProvider?.(
      createNvidiaMediaUnderstandingProvider({ http, profileReader: defaultProfileReader }),
    );

    api.logger?.info?.(
      "nvidia-speech plugin registered: speechProvider=nvidia " +
        "mediaUnderstandingProvider=nvidia (profile-fallback enabled)",
    );
  },
});

export default plugin;
