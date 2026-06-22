#!/usr/bin/env node
/**
 * Smoke test for the nvidia-speech plugin (Phase 6 verification).
 *
 * Exercises both TTS (speechProvider) and STT (mediaUnderstandingProvider)
 * factories from dist/index.js with the current openclaw config but WITHOUT
 * a real NVIDIA_API_KEY — we expect clean MissingApiKeyError messages and
 * proper provider shape (id, label, synthesize, isConfigured, etc).
 *
 * Run: node /tmp/nvidia-smoke.mjs
 */
import * as plugin from "/home/dhiraj/.openclaw/workspace/projects/nvidia-speech-plugin/dist/index.js";

let pass = 0, fail = 0;
const ok = (msg) => { pass++; console.log("  ✅", msg); };
const bad = (msg) => { fail++; console.error("  ❌", msg); };

console.log("\n=== 1. Plugin module shape ===");
if (plugin.default?.id === "nvidia-speech") ok(`default.id = "nvidia-speech"`);
else bad(`default.id = "${plugin.default?.id}"`);
if (typeof plugin.default?.register === "function") ok("default.register is a function");
else bad("default.register is missing or not a function");

const expectedReexports = ["FetchHttpClient", "RetryHttpClient", "MissingApiKeyError", "NvSpeechError"];
for (const name of expectedReexports) {
  if (name in plugin) ok(`re-export: ${name}`);
  else bad(`missing re-export: ${name}`);
}

console.log("\n=== 2. Build capture: register() ===");
let speechProvider = null;
let mediaProvider = null;

const api = {
  config: {
    meta: {}, wizard: {}, secrets: {}, auth: {},
    models: { providers: {} },
    agents: {},
    tools: { media: { audio: { enabled: true, models: [{ provider: "nvidia" }] } } },
    bindings: {},
    messages: {
      tts: {
        provider: "nvidia",
        providers: {
          nvidia: {
            voice: "Magpie-Multilingual.EN-US.Aria",
            model: "magpie-tts-multilingual",
            language: "en-US",
            sampleRate: 22050,
            format: "wav",
          },
        },
      },
    },
    commands: {},
  },
  logger: {
    info: (...a) => console.log("    [api.info]", ...a.map(String)),
    warn: (...a) => console.log("    [api.warn]", ...a.map(String)),
    error: (...a) => console.log("    [api.error]", ...a.map(String)),
    debug: () => {},
  },
  // OpenClaw runtime signature: registerSpeechProvider(provider: SpeechProviderPlugin)
  registerSpeechProvider(provider) {
    speechProvider = provider;
    console.log("    [capture] registerSpeechProvider called");
  },
  // Same: registerMediaUnderstandingProvider(provider: MediaUnderstandingProviderPlugin)
  registerMediaUnderstandingProvider(provider) {
    mediaProvider = provider;
    console.log("    [capture] registerMediaUnderstandingProvider called");
  },
  registerTool: () => {},
  on: () => {},
};

await plugin.default.register(api);

if (speechProvider) ok("TTS provider captured by register()");
else bad("TTS provider NOT captured by register()");
if (mediaProvider) ok("STT provider captured by register()");
else bad("STT provider NOT captured by register()");

console.log("\n=== 3. TTS provider shape ===");
if (speechProvider) {
  if (speechProvider.id === "nvidia") ok(`speechProvider.id = "nvidia"`);
  else bad(`speechProvider.id = "${speechProvider.id}"`);

  if (typeof speechProvider.label === "string" && speechProvider.label.length > 0) ok(`speechProvider.label = "${speechProvider.label}"`);
  else bad(`speechProvider.label = "${speechProvider.label}"`);

  if (typeof speechProvider.synthesize === "function") ok("speechProvider.synthesize() is a function");
  else bad("speechProvider.synthesize() missing");

  if (typeof speechProvider.isConfigured === "function") ok("speechProvider.isConfigured() is a function");
  else bad("speechProvider.isConfigured() missing");

  if (typeof speechProvider.listVoices === "function") ok("speechProvider.listVoices() is a function");
  else bad("speechProvider.listVoices() missing");

  if (Array.isArray(speechProvider.models)) ok(`speechProvider.models = [${speechProvider.models.join(", ")}]`);
  else bad(`speechProvider.models not array: ${typeof speechProvider.models}`);

  if (typeof speechProvider.defaultModel === "string") ok(`speechProvider.defaultModel = "${speechProvider.defaultModel}"`);
  else bad(`speechProvider.defaultModel missing`);
}

console.log("\n=== 4. STT provider shape ===");
if (mediaProvider) {
  if (mediaProvider.id === "nvidia") ok(`mediaProvider.id = "nvidia"`);
  else bad(`mediaProvider.id = "${mediaProvider.id}"`);

  if (typeof mediaProvider.transcribeAudio === "function") ok("mediaProvider.transcribeAudio() is a function");
  else bad("mediaProvider.transcribeAudio() missing");

  if (Array.isArray(mediaProvider.capabilities)) ok(`mediaProvider.capabilities = [${mediaProvider.capabilities.join(", ")}]`);
  else bad(`mediaProvider.capabilities not array: ${JSON.stringify(mediaProvider.capabilities)}`);

  if (mediaProvider.capabilities?.includes("audio")) ok(`mediaProvider.capabilities includes "audio"`);
  else bad(`mediaProvider.capabilities missing "audio"`);

  if (typeof mediaProvider.autoPriority?.audio === "number") ok(`mediaProvider.autoPriority.audio = ${mediaProvider.autoPriority.audio}`);
  else bad(`mediaProvider.autoPriority.audio missing`);
}

console.log("\n=== 5. TTS smoke (no API key) ===");
if (speechProvider) {
  // isConfigured should return false when no key is resolvable
  try {
    const configured = await speechProvider.isConfigured({ providerConfig: {} });
    if (configured === false) ok("isConfigured({}) = false (no key, correct)");
    else bad(`isConfigured({}) = ${JSON.stringify(configured)} (expected false)`);
  } catch (e) {
    bad(`isConfigured({}) threw: ${e?.message}`);
  }

  // synthesize should throw MissingApiKeyError
  try {
    await speechProvider.synthesize({ text: "smoke test" });
    bad("synthesize() returned cleanly (expected MissingApiKeyError)");
  } catch (e) {
    if (e?.name === "MissingApiKeyError") ok(`synthesize() threw MissingApiKeyError: "${e.message.slice(0, 70)}..."`);
    else bad(`synthesize() threw ${e?.name}: ${e?.message?.slice(0, 100)}`);
  }

  // listVoices should also throw MissingApiKeyError (or similar)
  try {
    await speechProvider.listVoices({});
    bad("listVoices() returned cleanly (expected MissingApiKeyError)");
  } catch (e) {
    if (e?.name === "MissingApiKeyError") ok("listVoices() threw MissingApiKeyError");
    else if (e?.name?.includes("Key") || e?.name?.includes("Auth")) ok(`listVoices() threw ${e.name} (auth-related)`);
    else bad(`listVoices() threw ${e?.name}: ${e?.message?.slice(0, 100)}`);
  }
}

console.log("\n=== 6. STT smoke (no API key) ===");
if (mediaProvider) {
  // Tiny fake WAV: 44-byte header + 1 sample of silence
  const fakeAudio = new Uint8Array(1024);
  try {
    await mediaProvider.transcribeAudio({ audio: fakeAudio, mimeType: "audio/wav" });
    bad("transcribeAudio() returned cleanly (expected MissingApiKeyError)");
  } catch (e) {
    if (e?.name === "MissingApiKeyError") ok(`transcribeAudio() threw MissingApiKeyError: "${e.message.slice(0, 70)}..."`);
    else bad(`transcribeAudio() threw ${e?.name}: ${e?.message?.slice(0, 100)}`);
  }
}

console.log("\n=== 7. Provider metadata sanity ===");
const ttsKeys = speechProvider ? Object.keys(speechProvider).sort() : [];
console.log(`    TTS provider keys: ${ttsKeys.join(", ")}`);
const sttKeys = mediaProvider ? Object.keys(mediaProvider).sort() : [];
console.log(`    STT provider keys: ${sttKeys.join(", ")}`);

const expectedTtsKeys = ["id", "label", "synthesize", "isConfigured", "listVoices", "models", "defaultModel"];
const missingTts = expectedTtsKeys.filter((k) => !ttsKeys.includes(k));
if (missingTts.length === 0) ok("TTS provider has all expected keys");
else bad(`TTS provider missing keys: ${missingTts.join(", ")}`);

const expectedSttKeys = ["id", "transcribeAudio", "capabilities", "defaultModels", "autoPriority"];
const missingStt = expectedSttKeys.filter((k) => !sttKeys.includes(k));
if (missingStt.length === 0) ok("STT provider has all expected keys");
else bad(`STT provider missing keys: ${missingStt.join(", ")}`);

console.log(`\n=== SMOKE RESULT ===`);
console.log(`  ✅ ${pass} passed, ❌ ${fail} failed`);
process.exitCode = fail > 0 ? 1 : 0;
