# `openclaw-nvidia-speech`

[![CI](https://github.com/dhiraj-salian/openclaw-nvidia-speech/actions/workflows/ci.yml/badge.svg)](https://github.com/dhiraj-salian/openclaw-nvidia-speech/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/openclaw-nvidia-speech)](https://www.npmjs.com/package/openclaw-nvidia-speech)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![OpenClaw Plugin](https://img.shields.io/badge/OpenClaw-plugin-blueviolet)](https://docs.openclaw.ai)

OpenClaw plugin that adds **NVIDIA TTS** (Magpie Multilingual) and **STT** (Parakeet CTC) capabilities using **only your existing `NVIDIA_API_KEY`**.

- 🎙️ **TTS** — natural multilingual speech from the Magpie Multilingual family.
- 🎤 **STT** — fast, accurate transcription from Parakeet CTC (English on the bundled NVCF function).
- 🔒 **No Google. No OpenAI. No Deepgram. No extra accounts.**
- ⚡ **Zero runtime npm deps** — uses Node 22's built-in `fetch`, `FormData`, `Blob`.
- 🧪 **168 unit + integration tests** — every layer verified offline before runtime.
- 🌐 **Live-verified against NVIDIA NVCF endpoints** — TTS round-trip + STT round-trip both green against the real function IDs (Checkpoint 5, 2026-06-23).

If you already pay for NVIDIA NIM access (it's free for the bundled models), this is the only plugin you need for voice in + voice out.

---

## Table of contents

- [Install](#install)
- [Configure](#configure)
- [Use](#use)
- [API reference](#api-reference)
- [Default endpoints (NVCF)](#default-endpoints-nvcf)
- [Troubleshoot](#troubleshoot)
- [Architecture](#architecture)
- [Contributing](#contributing)
- [License](#license)

---

## Install

> **Requirements:** OpenClaw `>=2026.3.24-beta.2`, Node `>=22.19.0`.

Pick **one** of the install paths below. They all install the same plugin.

### A. From GitHub (recommended)

```bash
openclaw plugins install github:dhiraj-salian/openclaw-nvidia-speech
```

### B. From npm

```bash
openclaw plugins install npm:openclaw-nvidia-speech
```

### C. From a local checkout (dev / hot-reload)

```bash
git clone https://github.com/dhiraj-salian/openclaw-nvidia-speech.git
cd openclaw-nvidia-speech
npm install && npm run build
openclaw plugins install --link ./
```

The `--link` flag symlinks the source so edits + a `npm run build` are picked up on the next plugin reload.

### D. From ClawHub (when published)

```bash
openclaw plugins install clawhub:openclaw-nvidia-speech
```

---

## Configure

You need one thing: **a NVIDIA API key with free credits** on
[build.nvidia.com](https://build.nvidia.com/settings/api-keys). The same key works for both TTS and STT.

### 1. Set the env var

```bash
# ~/.bashrc, ~/.zshrc, or your deployment secret store
export NVIDIA_API_KEY="nvapi-…"
```

### 2. Wire it into OpenClaw

OpenClaw interpolates `${NVIDIA_API_KEY}` at config-load time, so the secret
ref stays out of your committed JSON. Add this to `~/.openclaw/openclaw.json`:

```json5
{
  // ── TTS ──────────────────────────────────────────────────────────
  "messages": {
    "tts": {
      "auto": "always",                        // or "tagged" for opt-in
      "provider": "nvidia",                    // pick the bundled Magpie provider
      "providers": {
        "nvidia": {
          "apiKey": "${NVIDIA_API_KEY}",       // env-var secret ref
          "model": "magpie-tts-multilingual",  // (default; can be omitted)
          "voice": "Magpie-Multilingual.EN-US.Aria",
          "language": "en-US",
          "sampleRate": 22050,
          "format": "wav"                      // wav | mp3 | flac | ogg | opus
        }
      }
    }
  },

  // ── STT ──────────────────────────────────────────────────────────
  "tools": {
    "media": {
      "audio": {
        "enabled": true,
        "models": [
          { "provider": "nvidia" }              // picks the default Parakeet model
        ]
      }
    }
  }
}
```

Restart the gateway once (`openclaw gateway restart` or the equivalent for your platform).

### 3. Verify

```bash
openclaw plugins inspect nvidia-speech --runtime --json
```

You should see both `speechProviders: ["nvidia"]` and `mediaUnderstandingProviders: ["nvidia"]` registered.

---

## Use

### TTS

- **Auto-TTS** — every outbound reply becomes audio (after the `messages.tts.auto: "always"` config above).
- **One-off** — `/tts audio "Hello from NVIDIA"`
- **Status** — `/tts status`
- **Per-reply overrides** — use model-emitted directives:
  ```text
  Say it in a different voice.

  [[tts:voice=Magpie-Multilingual.HI-IN.Aditi lang=hi-IN format=mp3]]
  ```
- **Voices** — programmatically list via the bundled `tts voices` machinery; Magpie's available voices will show alongside the other providers.

### STT

Just send a voice note from any supported channel (WhatsApp, Telegram, Feishu, Matrix, Discord, …). OpenClaw will:

1. Detect the audio attachment.
2. Pick the first eligible entry in `tools.media.audio.models` — your NVIDIA provider.
3. POST the file as `multipart/form-data` to the Parakeet NVCF function (`/audio/transcriptions`).
4. Inject `[Audio] <transcript>` into the conversation.

> **Tip:** Add a local fallback for OOO cases:
> ```json5
> "tools": { "media": { "audio": { "models": [
>   { "provider": "nvidia" },
>   { "type": "cli", "command": "whisper", "args": ["--model", "base", "{{MediaPath}}"] }
> ] } } }
> ```

---

## API reference

### Default IDs

| Provider id | Purpose | Default model | Auto-priority |
|---|---|---|---|
| `nvidia` (TTS) | SpeechProviderPlugin — Magpie Multilingual | `magpie-tts-multilingual` | n/a |
| `nvidia` (STT) | MediaUnderstandingProviderPlugin — Parakeet CTC | `parakeet-ctc-1.1b-en-us` | `50` (higher than ElevenLabs at 45) |

### Per-provider config

| Path | Type | Default | Notes |
|---|---|---|---|
| `messages.tts.providers.nvidia.apiKey` | `string \| {value: string}` | — | Required. Use `"${NVIDIA_API_KEY}"` for env-var ref. |
| `messages.tts.providers.nvidia.model` | `string` | `magpie-tts-multilingual` | |
| `messages.tts.providers.nvidia.voice` | `string` | `Magpie-Multilingual.EN-US.Aria` | See `/audio/voices` for full list. |
| `messages.tts.providers.nvidia.language` | `string` | `en-US` | e.g. `en-US`, `hi-IN`, `de-DE`. |
| `messages.tts.providers.nvidia.sampleRate` | `number` | `22050` | 8000 / 16000 / 22050 / 24000 / 44100 / 48000. |
| `messages.tts.providers.nvidia.format` | `string` | `wav` | `wav` \| `mp3` \| `flac` \| `ogg` \| `opus`. |
| `messages.tts.providers.nvidia.baseUrl` | `string` | Magpie NVCF function URL | Override for a proxy / private NIM. |
| `tools.media.audio.models[].provider` | `"nvidia"` | — | Required. |
| `tools.media.audio.models[].model` | `string` | default above | Ignored by the live API — the function URL pins the model. |
| `tools.media.audio.models[].baseUrl` | `string` | Parakeet NVCF function URL | Override for a proxy / private NIM. |
| `tools.media.audio.models[].language` | `string` | `en-US` | Required by the Parakeet NVCF function. Other BCP-47 tags return HTTP 400. |

### Inline TTS directives

| Key | Example | Policy default |
|---|---|---|
| `voice` | `voice=Magpie-HI-IN.Aditi` | allowed |
| `model` | `model=magpie-tts-multilingual` | allowed |
| `lang` / `language` | `lang=hi-IN` | allowed |
| `format` | `format=mp3` | allowed |
| `sampleRate` | `sampleRate=24000` | allowed |
| `provider` | `provider=nvidia` | **disallowed** by default |

Enable `modelOverrides.allowProvider: true` if you want the assistant to switch providers mid-message.

---

## Default endpoints (NVCF)

Unlike the bundled chat-completions plugin, NVIDIA's audio models live on
**NVIDIA Cloud Functions** (NVCF), not on `integrate.api.nvidia.com`. Each
model is a separate function with its own ID and URL.

| Provider | Model | NVCF function ID | Endpoint |
|---|---|---|---|
| TTS (Magpie Multilingual) | `magpie-tts-multilingual` | `877104f7-e885-42b9-8de8-f6e4c6303969` | `{id}.invocation.api.nvcf.nvidia.com/v1/audio/synthesize` |
| STT (Parakeet CTC English) | `parakeet-ctc-1.1b-en-us` | `1598d209-5e27-4d3c-8079-4751568b1081` | `{id}.invocation.api.nvcf.nvidia.com/v1/audio/transcriptions` |

Override either with `messages.tts.providers.nvidia.baseUrl` or
`tools.media.audio.models[].baseUrl` (full URL, no function-ID substitution).
Type-checking stays strict — passing a model field to STT now returns HTTP 400.

**Notes:**
- Function IDs are deployment IDs. If NVIDIA rotates them you only need to
  update `src/config/defaults.ts` (or override via env vars
  `NVIDIA_TTS_BASE_URL` / `NVIDIA_STT_BASE_URL`).
- The current Parakeet function is English-only (`en-US`). Multilingual
  STT requires a separate NVCF function ID — tracked as a future enhancement.

---

## Troubleshoot

### `MissingApiKeyError: NVIDIA API key not found`

Either `NVIDIA_API_KEY` isn't set in the shell that runs the gateway, or the
`apiKey` config interpolation failed. Run:

```bash
echo "$NVIDIA_API_KEY"          # should print `nvapi-…`
openclaw plugins inspect nvidia-speech --runtime --json | jq '.config'
```

If the key is set but OpenClaw still complains, add `apiKey: "${NVIDIA_API_KEY}"` directly under `messages.tts.providers.nvidia` in `~/.openclaw/openclaw.json` (the path the runtime substitution uses).

### `HTTP 401: invalid api key`

The key is set but invalid. Generate a fresh one at
[build.nvidia.com/settings/api-keys](https://build.nvidia.com/settings/api-keys).

### `HTTP 429: rate limited`

NVIDIA's free tier rate-limits aggressively. The plugin auto-retries up to 3
times with exponential backoff (500 ms → 1 s → 2 s, capped at 8 s, with 0–250 ms jitter). If retries fail you'll see the underlying error surfaced — back off manually or upgrade your NVIDIA tier.

### `NvSpeechError kind=not_found`

The model id is wrong, or your account doesn't have access. The current
defaults (`magpie-tts-multilingual`, `parakeet-ctc-1.1b-en-multilingual`) are
on the free tier as of 2026-06.

### Voice note plays as a regular audio file in WhatsApp / Feishu

Make sure `format` is `mp3`, `ogg`, or `opus` (all native-supported codecs for
voice notes in those channels). `wav` works but is larger.

### Voice comes back as silent bytes

`sampleRate: 8000` is sometimes rejected by Magpie for female voices. Use `22050` (default) or `24000`.

### Plugin doesn't register after install

```bash
openclaw plugins list                       # confirm install
openclaw plugins inspect nvidia-speech      # check manifest + contracts
openclaw doctor                             # catch config-shape errors
```

---

## Architecture

| Layer | Path | Purpose |
|---|---|---|
| HTTP | `src/http/` | `HttpClient` interface + `FetchHttpClient` + `RetryHttpClient` decorator + `FakeHttpClient` (tests). |
| Errors | `src/http/errors.ts` | `NvSpeechError` hierarchy with `kind`, `status`, `requestId`. |
| Config | `src/config/` | Static defaults, validators, `normalizeRawConfig`. |
| Secrets | `src/utils/secret-resolver.ts` | API-key precedence chain; never logs. |
| TTS | `src/tts/nvidia-tts-client.ts` | Raw `POST /audio/synthesize`. |
| TTS | `src/tts/voices.ts` | `GET /audio/list_voices` with 1 h cache (handles nested Magpie shape). |
| TTS | `src/tts/speech-provider.ts` | The OpenClaw `SpeechProviderPlugin` boundary. |
| STT | `src/stt/nvidia-stt-client.ts` | Raw `POST /audio/transcriptions` (multipart). |
| STT | `src/stt/media-provider.ts` | The OpenClaw `MediaUnderstandingProviderPlugin` boundary. |
| Entry | `src/index.ts` | `definePluginEntry` + factory wiring. |

**SOLID highlights:**
- **D (Dependency Inversion)** — every layer depends on `HttpClient`, not `fetch`.
- **S (Single Responsibility)** — TTS and STT are completely separate files.
- **I (Interface Segregation)** — provider shape mirrors OpenClaw's narrow contracts.
- **O (Open/Closed)** — `RetryHttpClient` decorates `FetchHttpClient` without modifying it.
- **Strategy** — `parseTranscribeResponse` accepts multiple response shapes.

**Zero runtime deps.** Pulls in only `esbuild` / `typescript` / `vitest` as `devDependencies`.

---

## Contributing

```bash
git clone https://github.com/dhiraj-salian/openclaw-nvidia-speech.git
cd openclaw-nvidia-speech
nvm use                       # picks up .nvmrc (node 22)
npm install
npm run ci                    # typecheck + test + build
```

Open a PR. CI runs the same `npm run ci` on every push.

**Conventions:**
- TDD — tests land first (`*.test.ts`), implementation second.
- TypeScript strict (everything in `tsconfig.json`).
- ESLint not used (the project leans on `tsc --noEmit` as the lint gate).
- No `console.log` in `src/` — use the `api.logger` from the host runtime instead.

---

## License

MIT — see [LICENSE](./LICENSE).
