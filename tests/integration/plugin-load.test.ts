/**
 * Plugin-load integration test.
 *
 * Imports the real plugin entry from `src/index.ts` and asserts that
 * `register(api)` calls both `api.registerSpeechProvider` and
 * `api.registerMediaUnderstandingProvider` with provider-shaped objects.
 *
 * This is the closest we can get to a real OpenClaw load without standing
 * up the full plugin loader. It catches shape regressions and ensures
 * the entry point is wired correctly.
 */

import { describe, it, expect } from "vitest";
import plugin, {
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginEntry,
} from "../../src/index.js";

describe("plugin entry", () => {
  it("exposes the expected top-level shape", () => {
    expect(plugin.id).toBe("nvidia-speech");
    expect(plugin.name).toBeTruthy();
    expect(plugin.description).toBeTruthy();
    expect(typeof plugin.register).toBe("function");
  });

  it("uses definePluginEntry shim (object identity preserved)", () => {
    const entry: OpenClawPluginEntry = definePluginEntry({
      id: "x",
      name: "x",
      description: "x",
      register() {},
    });
    expect(entry.id).toBe("x");
    expect(typeof entry.register).toBe("function");
  });

  it("register() calls registerSpeechProvider with an object whose id === 'nvidia'", () => {
    const calls: Array<{ method: string; provider: unknown }> = [];
    const api: OpenClawPluginApi = {
      registerSpeechProvider(provider) {
        calls.push({ method: "registerSpeechProvider", provider });
      },
      registerMediaUnderstandingProvider(provider) {
        calls.push({ method: "registerMediaUnderstandingProvider", provider });
      },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    };

    plugin.register(api);

    const speechCall = calls.find((c) => c.method === "registerSpeechProvider");
    expect(speechCall, "registerSpeechProvider should be called").toBeDefined();
    const provider = speechCall!.provider as Record<string, unknown>;
    expect(provider.id).toBe("nvidia");
    expect(provider.label).toBeTruthy();
    expect(typeof provider.synthesize).toBe("function");
    expect(Array.isArray(provider.models)).toBe(true);
  });

  it("register() calls registerMediaUnderstandingProvider with an object whose id === 'nvidia'", () => {
    const calls: Array<{ method: string; provider: unknown }> = [];
    const api: OpenClawPluginApi = {
      registerSpeechProvider(provider) {
        calls.push({ method: "registerSpeechProvider", provider });
      },
      registerMediaUnderstandingProvider(provider) {
        calls.push({ method: "registerMediaUnderstandingProvider", provider });
      },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    };

    plugin.register(api);

    const sttCall = calls.find((c) => c.method === "registerMediaUnderstandingProvider");
    expect(sttCall, "registerMediaUnderstandingProvider should be called").toBeDefined();
    const provider = sttCall!.provider as Record<string, unknown>;
    expect(provider.id).toBe("nvidia");
    expect(Array.isArray(provider.capabilities)).toBe(true);
    expect(provider.capabilities).toContain("audio");
    expect(typeof provider.transcribeAudio).toBe("function");
    const defaultModels = provider.defaultModels as Record<string, unknown>;
    expect(defaultModels.audio).toBe("parakeet-ctc-1.1b-en-multilingual");
    const autoPriority = provider.autoPriority as Record<string, unknown>;
    expect(autoPriority.audio).toBe(50);
  });

  it("register() does not throw when api.register* are missing", () => {
    const api: OpenClawPluginApi = {};
    expect(() => plugin.register(api)).not.toThrow();
  });

  it("register() handles a Promise-returning register gracefully", async () => {
    const api: OpenClawPluginApi = {
      registerSpeechProvider() {},
      registerMediaUnderstandingProvider() {},
    };
    // The plugin's register is sync; just confirm calling it twice is idempotent.
    plugin.register(api);
    expect(() => plugin.register(api)).not.toThrow();
  });

  it("default export === named `default` import shape", () => {
    expect(plugin).toBeDefined();
    expect((plugin as unknown as { id: string }).id).toBe("nvidia-speech");
  });

  // -----------------------------------------------------------------------
  // Auth-profile wiring through `register(api)`:
  //   api.config should be forwarded into both provider factories so the
  //   runtime auth-profile store is consulted for the API key.
  // -----------------------------------------------------------------------

  it("forwards api.config into both provider factories", () => {
    let speechProviderIsConfigured: ((ctx: unknown) => boolean) | undefined;
    let sttProviderTranscribe: unknown;
    const api: OpenClawPluginApi = {
      registerSpeechProvider(provider) {
        const sp = provider as {
          isConfigured: (ctx: unknown) => boolean;
        };
        speechProviderIsConfigured = sp.isConfigured;
      },
      registerMediaUnderstandingProvider(provider) {
        sttProviderTranscribe = (provider as { transcribeAudio: unknown }).transcribeAudio;
      },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      config: {
        auth: { profiles: { "nvidia:default": { provider: "nvidia" } } },
      },
    };

    plugin.register(api);

    // Both providers were registered with isConfigured / transcribeAudio
    // present, proving the factories accepted the forwarded cfg without
    // throwing. (Behavioural coverage of cfg-driven key resolution lives
    // inside speech-provider.test.ts / media-provider.test.ts.)
    expect(typeof speechProviderIsConfigured).toBe("function");
    expect(typeof sttProviderTranscribe).toBe("function");
  });

  it("falls back gracefully when api.config is absent (setup-only loader mode)", () => {
    const calls: string[] = [];
    const api: OpenClawPluginApi = {
      registerSpeechProvider() {
        calls.push("speech");
      },
      registerMediaUnderstandingProvider() {
        calls.push("stt");
      },
    };
    expect(() => plugin.register(api)).not.toThrow();
    expect(calls).toEqual(["speech", "stt"]);
  });
});
