# Implementation Plan: `openclaw-nvidia-speech` Plugin

## Overview

A standalone, publishable OpenClaw plugin (`@dhirajpatra/openclaw-nvidia-speech`) that adds NVIDIA **TTS** (Magpie Multilingual) and **STT** (Parakeet CTC) capabilities to OpenClaw using only the user's existing NVIDIA API key.

**Why it exists:** OpenClaw 2026.6.6 ships with no NVIDIA speech provider. The bundled `nvidia` plugin is chat-completions only. Users with an NVIDIA key cannot transcribe voice notes (STT) or synthesize replies aloud (TTS) without depending on Google/OpenAI/Deepgram. This plugin closes that gap.

**Outcome:** Install → `messages.tts.provider: "nvidia"` and `tools.media.audio.models: [{ provider: "nvidia" }` both work. No secrets in code. No Google/OpenAI/Deepgram dependency.

---

## Architecture Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | **Single plugin, two registrations** (`registerSpeechProvider` + `registerMediaUnderstandingProvider`) | Mirrors the bundled `elevenlabs` pattern. Atomic install. |
| 2 | **TypeScript ESM, Node 22+, zero runtime deps** (use built-in `fetch`, `FormData`, `URL`) | OpenClaw is Node 22 + ESM only; bundled 11Labs already does this. Smaller, auditable, no supply-chain bloat. |
| 3 | **Test runner: Vitest** (dev dep only) | Fastest ESM-native runner, great TS support, watch mode. Vitest is the de facto standard for OpenClaw plugins. |
| 4 | **`HttpClient` interface + `FetchHttpClient` implementation** (Dependency Inversion) | Allows injecting a fake for unit tests without mocking `fetch` globally. SOLID-D. |
| 5 | **Domain types in `src/types.ts`, transport code in `src/http/`, providers in `src/providers/`** | Clean Architecture: domain ≠ transport ≠ provider. SOLID-S (one reason to change per module). |
| 6 | **Strategy pattern for response parsers** (`ParsesJson`, `ParsesMultipart`, `ParsesRawAudio`) | OpenClaw runtime needs different result shapes per call type. Lets us test parsers in isolation. |
| 7 | **Secrets resolved via OpenClaw `resolveProviderApiKey`/`config.apiKey`/`process.env.NVIDIA_API_KEY` chain** | Matches ElevenLabs plugin's `resolveElevenLabsApiKeyWithProfileFallback` pattern. Never hardcode. |
| 8 | **Factory pattern: `createNvidiaSpeechProvider()` returns the plugin shape** | Mirrors `buildElevenLabsSpeechProvider()`. Pure function, fully unit-testable. |
| 9 | **No npm deps at runtime → package size <30KB, no `node_modules` complexity** | Less to audit. Faster `openclaw plugins install`. |
| 10 | **Repo layout: TypeScript source + ESBuild step to `dist/`** | OpenClaw docs warn: published plugins must ship compiled JS or load source via `plugins.load.paths`. We build for both. |

---

## SOLID / Pattern Mapping

| Principle/Pattern | Where it shows up |
|---|---|
| **S**ingle Responsibility | `NvidiaTtsClient` only speaks to TTS endpoint; `NvidiaSttClient` only speaks to STT endpoint. Validators in their own files. |
| **O**pen/Closed | `HttpClient` is an interface → extend with `LoggingHttpClient`, `RetryHttpClient` decorators without touching `FetchHttpClient`. |
| **L**iskov Substitution | Any `HttpClient` impl works in `NvidiaTtsClient` — verified by tests using a `FakeHttpClient`. |
| **I**nterface Segregation | `SpeechProvider`, `MediaUnderstandingProvider` are the only required plugin contracts. No kitchen-sink interface. |
| **D**ependency Inversion | High-level modules (`buildNvidiaSpeechProvider`) depend on abstractions (`HttpClient`), not on `fetch`. |
| **Factory** | `createNvidiaSpeechProvider()`, `createNvidiaSttProvider()` |
| **Strategy** | `parseSynthesizeResponse`, `parseTranscribeResponse` (different shapes per call) |
| **Decorator** (potential) | `RetryHttpClient` wraps `FetchHttpClient` if needed for transient failures |
| **Builder** | `SynthesizeRequestBuilder` chains voice/lang/format/output fluently |
| **Value Object** | `NvidiaConfig` immutable after construction; all mutations go through `with()` |
| **Repository** (light) | The plugin entry itself — registers providers with the host |

---

## NVIDIA API Contracts (Verified)

### TTS — Magpie Multilingual (`magpie-tts-multilingual`)
- **Endpoint:** `POST https://integrate.api.nvidia.com/v1/audio/synthesize`
- **Auth:** `Authorization: Bearer $NVIDIA_API_KEY`
- **Request body (JSON):**
  ```json
  {
    "model": "magpie-tts-multilingual",
    "text": "Hello world",
    "voice_name": "Magpie-Multilingual.EN-US.Aria",
    "language_code": "en-US",
    "audio_format": "wav",
    "sample_rate_hz": 22050,
    "encoding": "LINEAR16"
  }
  ```
- **Response:** `audio/wav` bytes (or chosen format)
- **Voices endpoint:** `GET /v1/audio/voices` → list of `{ name, language, gender }`

### STT — Parakeet CTC (`parakeet-ctc-1.1b-en-multilingual` or similar)
- **Endpoint:** `POST https://integrate.api.nvidia.com/v1/audio/transcriptions` (OpenAI-compatible multipart)
- **Auth:** `Authorization: Bearer $NVIDIA_API_KEY`
- **Request:** `multipart/form-data` with `file`, `model`, optional `language`, `response_format: "json"`
- **Response:** `{ "text": "..." }`

### Default endpoint
`https://integrate.api.nvidia.com/v1` (configurable in `messages.tts.providers.nvidia.baseUrl` / `tools.media.audio.request.baseUrl`).

---

## Repo Layout

```
openclaw-nvidia-speech/
├── README.md                      # install, configure, use, troubleshoot
├── LICENSE                        # MIT
├── package.json                   # @dhirajpatra/openclaw-nvidia-speech
├── openclaw.plugin.json           # plugin manifest (contracts + setup)
├── tsconfig.json                  # strict, ESNext, NodeNext
├── vitest.config.ts               # test runner config
├── .gitignore
├── .nvmrc                         # node 22
├── .github/
│   └── workflows/
│       └── ci.yml                 # lint + typecheck + test on PR
├── src/
│   ├── index.ts                   # plugin entry: registerSpeechProvider + registerMediaUnderstandingProvider
│   ├── config/
│   │   ├── schema.ts              # config types + Zod-style validators (manual, no dep)
│   │   ├── normalize.ts           # resolve API key chain, normalize defaults
│   │   └── defaults.ts            # DEFAULT_VOICE, DEFAULT_MODEL, etc.
│   ├── http/
│   │   ├── http-client.ts         # HttpClient interface
│   │   ├── fetch-http-client.ts   # FetchHttpClient implementation
│   │   ├── fake-http-client.ts    # test double
│   │   ├── retry-http-client.ts   # decorator: exponential backoff on 429/5xx
│   │   └── errors.ts              # NvSpeechError hierarchy
│   ├── tts/
│   │   ├── nvidia-tts-client.ts   # raw client
│   │   ├── synthesize.ts          # SynthesizeRequestBuilder + parser
│   │   ├── voices.ts              # listVoices()
│   │   ├── speech-provider.ts     # SpeechProviderPlugin shape → OpenClaw
│   │   └── speech-provider.test.ts
│   ├── stt/
│   │   ├── nvidia-stt-client.ts   # raw client (multipart)
│   │   ├── transcribe.ts          # parseTranscribeResponse
│   │   ├── media-provider.ts      # MediaUnderstandingProviderPlugin shape → OpenClaw
│   │   └── media-provider.test.ts
│   └── utils/
│       ├── secret-resolver.ts     # resolveApiKey(rawConfig, envVar)
│       ├── language-codes.ts      # "en-US" → ISO mapping
│       └── file-name.ts           # guess extension from MIME
└── tests/
    ├── integration/
    │   └── plugin-load.test.ts    # loads dist/index.js into a fake OpenClaw api
    ├── fixtures/
    │   ├── sample.wav             # tiny silent wav
    │   └── sample.opus            # tiny silent opus
    └── e2e/
        └── live-nvidia.test.ts    # SKIP unless NVIDIA_API_KEY set in env
```

---

## Task List

### Phase 1: Foundation

- [ ] **Task 1: Repo scaffold + package metadata**
  - Create directory, `package.json`, `tsconfig.json`, `.gitignore`, `.nvmrc`, `LICENSE`, `vitest.config.ts`, `.github/workflows/ci.yml`
  - Acceptance: `npm install` succeeds; `npx tsc --noEmit` passes on empty `src/index.ts`
  - Verify: `npm run typecheck` exits 0
  - Files: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.nvmrc`, `LICENSE`, `.github/workflows/ci.yml`
  - Size: S

- [ ] **Task 2: `openclaw.plugin.json` manifest**
  - Declare id `nvidia-speech`, contracts `speechProviders: ["nvidia"]` + `mediaUnderstandingProviders: ["nvidia"]`, setup with `envVars: ["NVIDIA_API_KEY"]`, `enabledByDefault: false`
  - Acceptance: `openclaw plugins inspect ./openclaw.plugin.json` shows correct schema
  - Verify: manual schema inspection
  - Files: `openclaw.plugin.json`
  - Size: XS

- [ ] **Task 3: HTTP client interface + FetchHttpClient (TDD)**
  - RED: tests for `FetchHttpClient` against a real public endpoint (httpbin.org/status/200, 500) — must throw on non-2xx, return parsed JSON on `application/json`, return bytes otherwise
  - GREEN: implement `HttpClient` interface (`request<T>`) and `FetchHttpClient` using built-in `fetch`
  - Verify: `npm test -- http-client` passes
  - Files: `src/http/http-client.ts`, `src/http/fetch-http-client.ts`, `src/http/fetch-http-client.test.ts`, `src/http/errors.ts`
  - Size: M

- [ ] **Task 4: FakeHttpClient + RetryHttpClient decorator (TDD)**
  - RED: tests for `FakeHttpClient` (records calls, returns canned responses), `RetryHttpClient` (retries on 429/503 with exponential backoff, max 3 attempts)
  - GREEN: implement
  - Verify: `npm test -- http-client` all green
  - Files: `src/http/fake-http-client.ts`, `src/http/retry-http-client.ts`, `*.test.ts`
  - Size: M

### Checkpoint 1: Foundation
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (all http tests green)
- [ ] Plugin manifest validates
- [ ] Review with Dhiraj

### Phase 2: Domain / Config

- [ ] **Task 5: Config types + validators (TDD)**
  - RED: tests for `normalizeConfig({...})` — defaults applied, invalid voice rejected, ranges clamped (sample rate ∈ [8000, 48000])
  - GREEN: implement pure functions, no I/O
  - Verify: `npm test -- config` all green
  - Files: `src/config/schema.ts`, `src/config/normalize.ts`, `src/config/defaults.ts`, `src/config/normalize.test.ts`
  - Size: M

- [ ] **Task 6: Secret resolver (TDD)**
  - RED: tests for `resolveApiKey({ rawConfig, profileFallback, envVar })` — priority: explicit value → env → throw
  - GREEN: implement; **never log the value**
  - Verify: `npm test -- secret-resolver` green
  - Files: `src/utils/secret-resolver.ts`, `src/utils/secret-resolver.test.ts`
  - Size: S

### Checkpoint 2: Domain
- [ ] All tests pass
- [ ] No `process.env.NVIDIA_API_KEY` literal in source (must reference the env var by name parameter)

### Phase 3: TTS

- [ ] **Task 7: `NvidiaTtsClient.synthesize` raw HTTP (TDD)**
  - RED: tests for request shape (URL, headers, body), response parsing (bytes → `ArrayBuffer`)
  - GREEN: implement using `HttpClient` injection
  - Verify: `npm test -- tts/client` green
  - Files: `src/tts/nvidia-tts-client.ts`, `src/tts/nvidia-tts-client.test.ts`
  - Size: M

- [ ] **Task 8: `listVoices` (TDD)**
  - RED: tests for response parsing (array of `{ id, name, language, gender }`)
  - GREEN: implement; cache for 1 hour
  - Verify: `npm test -- tts/voices` green
  - Files: `src/tts/voices.ts`, `src/tts/voices.test.ts`
  - Size: S

- [ ] **Task 9: `SpeechProviderPlugin` shape (TDD)**
  - RED: tests for `synthesize()` → returns `{ audioBuffer, outputFormat, fileExtension, voiceCompatible }`; `isConfigured()`; `resolveConfig()`; `parseDirectiveToken()` (handle `voice:`, `model:`, `lang:`, `format:` inline overrides)
  - GREEN: wire `NvidiaTtsClient` + `resolveApiKey` into the plugin shape
  - Verify: `npm test -- tts/speech-provider` green; `openclaw plugins inspect` shows correct registration
  - Files: `src/tts/speech-provider.ts`, `src/tts/speech-provider.test.ts`
  - Size: L

### Phase 4: STT

- [ ] **Task 10: `NvidiaSttClient.transcribe` raw HTTP (TDD)**
  - RED: tests for multipart construction (file field, model field, language field), JSON response parsing
  - GREEN: implement using `HttpClient` injection; **no `form-data` npm package — use `FormData` + `Blob` built-ins**
  - Verify: `npm test -- stt/client` green
  - Files: `src/stt/nvidia-stt-client.ts`, `src/stt/nvidia-stt-client.test.ts`
  - Size: M

- [ ] **Task 11: `MediaUnderstandingProviderPlugin` shape (TDD)**
  - RED: tests for `transcribeAudio()` returning `{ text, model }`; `defaultModels: { audio: "parakeet-ctc-1.1b-en-multilingual" }`; `autoPriority: { audio: 50 }` (same tier as ElevenLabs)
  - GREEN: wire STT client
  - Verify: `npm test -- stt/media-provider` green
  - Files: `src/stt/media-provider.ts`, `src/stt/media-provider.test.ts`
  - Size: M

### Phase 5: Plugin entry + integration

- [ ] **Task 12: `src/index.ts` plugin entry**
  - Calls `definePluginEntry({ id: "nvidia-speech", ... })` and registers both providers
  - Acceptance: imports cleanly, no runtime side effects until `register(api)` is called
  - Verify: `npm run typecheck` green; `npm run build` emits `dist/index.js`
  - Files: `src/index.ts`
  - Size: S

- [ ] **Task 13: Plugin-load integration test**
  - Mock `OpenClawPluginApi`, call `register(api)`, assert `registerSpeechProvider` and `registerMediaUnderstandingProvider` were called with provider ids `nvidia`
  - Acceptance: `npm test -- integration/plugin-load` passes
  - Verify: `npm test` all green
  - Files: `tests/integration/plugin-load.test.ts`
  - Size: S

- [ ] **Task 14: Build pipeline**
  - `npm run build` → `esbuild src/index.ts --bundle --platform=node --target=node22 --format=esm --outfile=dist/index.js --external:openclaw/*`
  - Acceptance: `dist/index.js` exists, runs with `node`, no missing imports
  - Verify: `node dist/index.js` (will throw on missing api, but should not crash on import)
  - Files: `package.json` (scripts), `scripts/build.mjs`
  - Size: S

### Checkpoint 3: Plugin ready
- [ ] All tests pass (`npm test`)
- [ ] Build succeeds (`npm run build`)
- [ ] `dist/index.js` + `openclaw.plugin.json` present
- [ ] No secrets, no dead code, no `console.log`

### Phase 6: Local runtime verification

- [ ] **Task 15: Install plugin into local OpenClaw**
  - `openclaw plugins install --link ./openclaw-nvidia-speech`
  - Add `NVIDIA_API_KEY` to secrets (ask Dhiraj at runtime)
  - Configure `messages.tts.providers.nvidia.apiKey` + `tools.media.audio.models`
  - Restart Gateway
  - Verify: `openclaw plugins inspect nvidia-speech --runtime --json` shows both providers registered
  - Files: `~/.openclaw/openclaw.json` (config)
  - Size: S

- [ ] **Task 16: Live TTS smoke test**
  - `openclaw infer audio transcribe` is for STT; for TTS: use `tts.speak` via agent or trigger via test message
  - Easier: `node -e "import('./dist/index.js')..."` is hard; use the `openclaw tts` command if available, OR write a tiny Node script that imports the synthesized path
  - Verify: hear the audio or see non-empty `.wav` bytes
  - Size: S

- [ ] **Task 17: Live STT smoke test**
  - Record a short voice memo on phone, send to WhatsApp bot, confirm transcript appears in reply
  - Verify: transcript text is correct
  - Size: S

### Checkpoint 4: Runtime verified
- [ ] STT roundtrip works end-to-end
- [ ] TTS roundtrip works end-to-end
- [ ] No regressions in other plugins

### Phase 7: Publish + docs

- [ ] **Task 18: README.md**
  - Badges, install (ClawHub / npm / git), config, usage examples, troubleshoot (401, 429, missing voice), contributing
  - Files: `README.md`
  - Size: M

- [ ] **Task 19: GitHub repo + push**
  - `git init`, first commit, create GitHub repo `dhirajpatra/openclaw-nvidia-speech`, push, protect main branch
  - Size: S

- [ ] **Task 20: GitHub Actions CI**
  - Already scaffolded in Task 1; verify it runs on first push
  - Size: XS

- [ ] **Task 21: ClawHub manifest**
  - Write `clawhub.package.json`, run `clawhub package publish --dry-run`
  - Size: S

- [ ] **Task 22: npm publish (optional)**
  - `npm publish --access public` if you want it on npm too
  - Size: XS

### Checkpoint 5: Shipped
- [ ] GitHub repo public, README renders
- [ ] ClawHub package metadata valid
- [ ] CI green
- [ ] Dhiraj signs off

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| NVIDIA API surface drifts (they've restructured NIM endpoints before) | High | Pin to specific model ids; `baseUrl` is configurable; integration test against real API in CI before release |
| Magpie returns audio in a format OpenClaw doesn't recognize | Med | Detect format via `Content-Type` header; default to `wav` |
| Parakeet is English-only | Med | Default to multilingual variant when available; expose `language` override |
| Rate limiting (free tier is tight) | Low | `RetryHttpClient` with exponential backoff; surface clear errors to user |
| Bundled `nvidia` plugin collision | Low | Use plugin id `nvidia-speech`, not `nvidia` |
| API key leaks via test fixtures or logs | High | `.gitignore` env files; `secret-resolver` never logs values; tests use fake keys only |

---

## Open Questions for Dhiraj

1. **GitHub org:** `dhirajpatra/openclaw-nvidia-speech` or `dhiraj/openclaw-nvidia-speech` or your own org?
2. **License:** MIT (default) or Apache-2.0?
3. **Default voice:** Magpie ships several — `Magpie-Multilingual.EN-US.Aria` (female, en) is a safe default. Confirm?
4. **STT model:** `parakeet-ctc-1.1b-en-multilingual` is multilingual + accurate. Confirm or prefer the English-only smaller `parakeet-ctc-0.6b` for speed?
5. **ClawHub now or later?** Publishing needs `clawhub` CLI + account.
6. **Should I remove the bundled `nvidia` chat provider?** (separate task — leaving for later unless you say so)

---

## Estimated Scope

| Phase | Tasks | Files | Est. time |
|---|---|---|---|
| Phase 1 Foundation | 4 | ~12 | ~25 min |
| Phase 2 Domain | 2 | ~6 | ~10 min |
| Phase 3 TTS | 3 | ~8 | ~20 min |
| Phase 4 STT | 2 | ~5 | ~15 min |
| Phase 5 Integration | 3 | ~4 | ~10 min |
| Phase 6 Runtime | 3 | ~2 | ~10 min |
| Phase 7 Publish | 5 | ~4 | ~15 min |
| **Total** | **22** | **~40** | **~105 min** |

---

## Verification Checklist (Run Before Marking Complete)

- [ ] `npm run typecheck` — zero errors
- [ ] `npm test` — all green
- [ ] `npm run build` — clean
- [ ] No `console.log`, no TODO/FIXME, no commented-out code
- [ ] `grep -r "nvapi\|nvapi-\|NVIDIA_API_KEY.*=.*['\"]" src/` returns nothing (no hardcoded keys)
- [ ] `grep -r "process.env" src/` only references the env var by parameter, never literal
- [ ] README has working copy-paste config example
- [ ] GitHub repo + CI green
- [ ] Live TTS + STT smoke test passed
