#!/usr/bin/env node
/**
 * Live smoke test using the REAL openclaw.json config.
 *
 * Exercises the same code path the gateway uses:
 *   - api.config = parsed openclaw.json
 *   - resolveApiKeyForProvider hits the SQLite auth profile store
 *   - Eager resolve kicks off in register(); we wait for it to complete
 *     before testing (real gateway requests are seconds-to-minutes later,
 *     so the eager resolve has always completed by then).
 *
 * Requires NVIDIA_API_KEY to be present in atlas's auth profile store
 * (configured via `openclaw auth profiles set nvidia:default key=***`).
 * Tests BOTH auth resolution AND a real NVIDIA API call.
 *
 * Run: node scripts/smoke-live.mjs
 */
import fs from "node:fs";
import * as plugin from "/home/dhiraj/.openclaw/workspace/projects/nvidia-speech-plugin/dist/index.js";

const cfgPath = process.env.OPENCLAW_CONFIG || "/home/dhiraj/.openclaw/openclaw.json";
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
console.log(`[smoke-live] loaded config from ${cfgPath}`);

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log("  ✅", m); };
const bad = (m) => { fail++; console.error("  ❌", m); };

let speechProvider = null, mediaProvider = null;

const api = {
  config: cfg,
  logger: {
    info: (...a) => console.log("    [api.info]", ...a.map(String)),
    warn: (...a) => console.log("    [api.warn]", ...a.map(String)),
    error: (...a) => console.log("    [api.error]", ...a.map(String)),
    debug: () => {},
  },
  registerSpeechProvider: (p) => { speechProvider = p; },
  registerMediaUnderstandingProvider: (p) => { mediaProvider = p; },
  registerTool: () => {},
  on: () => {},
};

console.log("\n=== Register plugin with real cfg ===");
const t0 = Date.now();
await plugin.default.register(api);
console.log(`[smoke-live] register() returned in ${Date.now() - t0}ms`);

if (!speechProvider || !mediaProvider) {
  console.error("FATAL: providers not registered");
  process.exit(2);
}

console.log("\n=== Wait for eager auth resolve to complete (max 3s) ===");
// The eager resolve is fire-and-forget; the smoke test must wait for it.
// In the real gateway, requests arrive seconds/minutes later so this is implicit.
let waited = 0;
const probeIsConfigured = async () => speechProvider.isConfigured({ providerConfig: {} });
while (waited < 3000) {
  if (await probeIsConfigured()) {
    console.log(`[smoke-live] auth-profile resolve completed after ${waited}ms`);
    break;
  }
  await new Promise(r => setTimeout(r, 100));
  waited += 100;
}
if (await probeIsConfigured()) {
  ok("auth-profile key resolved via SDK");
} else {
  bad("auth-profile key NOT resolved within 3s — check ~/.openclaw/agents/atlas/agent/openclaw-agent.sqlite for nvidia:default profile");
}

console.log("\n=== TTS: synthesize 'Hello, this is a live smoke test.' ===");
try {
  const result = await speechProvider.synthesize({ text: "Hello, this is a live smoke test." });
  const audioBytes = result.audio ? (result.audio.length ?? result.audio.byteLength) : 0;
  console.log("    synthesize() returned:", JSON.stringify({
    mimeType: result.mimeType,
    audioBytes,
    voice: result.voice,
    model: result.model,
    requestId: result.requestId,
  }, null, 2));
  if (audioBytes > 100) {
    ok(`synthesize() returned ${audioBytes} bytes of audio (mimeType=${result.mimeType})`);
    if (process.env.SMOKE_SAVE_AUDIO) {
      fs.writeFileSync(process.env.SMOKE_SAVE_AUDIO, Buffer.from(result.audio));
      ok(`audio saved to ${process.env.SMOKE_SAVE_AUDIO}`);
    }
  } else {
    bad(`synthesize() returned no/short audio (${audioBytes} bytes)`);
  }
} catch (e) {
  bad(`synthesize() threw ${e.name}: ${e.message?.slice(0, 200)}`);
}

console.log("\n=== TTS: listVoices (sample) ===");
try {
  const voices = await speechProvider.listVoices({});
  console.log(`    listVoices() returned ${voices?.length ?? 0} voices`);
  if (voices?.length > 0) {
    console.log(`    first 5: ${voices.slice(0, 5).map(v => v.id ?? v.name).join(", ")}`);
    ok(`listVoices() returned ${voices.length} voices`);
  } else {
    bad("listVoices() returned empty array");
  }
} catch (e) {
  bad(`listVoices() threw ${e.name}: ${e.message?.slice(0, 200)}`);
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exitCode = fail > 0 ? 1 : 0;
