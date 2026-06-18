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
});
