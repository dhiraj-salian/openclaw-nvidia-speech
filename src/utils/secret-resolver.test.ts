import { describe, it, expect } from "vitest";
import { resolveApiKey, MissingApiKeyError, redactConfig } from "./secret-resolver.js";

describe("resolveApiKey", () => {
  it("prefers explicit provided over env", () => {
    const out = resolveApiKey({
      provided: "explicit-key",
      envVar: "NVIDIA_API_KEY",
      env: { NVIDIA_API_KEY: "env-key" },
    });
    expect(out).toBe("explicit-key");
  });

  it("falls back to env when no provided", () => {
    const out = resolveApiKey({
      envVar: "NVIDIA_API_KEY",
      env: { NVIDIA_API_KEY: "env-key" },
    });
    expect(out).toBe("env-key");
  });

  it("trims whitespace from provided value", () => {
    expect( resolveApiKey({ provided: "  hi  " })).toBe("hi");
  });

  it("coerces SecretRef-like { value } objects", () => {
    expect(resolveApiKey({ provided: { value: "from-ref" } })).toBe("from-ref");
  });

  it("throws when nothing available", () => {
    expect(() =>
      resolveApiKey({ envVar: "NVIDIA_API_KEY", env: {} }),
    ).toThrow(MissingApiKeyError);
  });

  it("throws when env value is empty string", () => {
    expect(() =>
      resolveApiKey({ envVar: "NVIDIA_API_KEY", env: { NVIDIA_API_KEY: "" } }),
    ).toThrow(MissingApiKeyError);
  });

  it("throws when provided is empty string", () => {
    expect(() =>
      resolveApiKey({ provided: "   ", env: {} }),
    ).toThrow(MissingApiKeyError);
  });

  it("defaults env var name to NVIDIA_API_KEY", () => {
    const out = resolveApiKey({ env: { NVIDIA_API_KEY: "default-name" } });
    expect(out).toBe("default-name");
  });

  it("uses custom env var name when provided", () => {
    const out = resolveApiKey({
      envVar: "MY_CUSTOM_KEY",
      env: { MY_CUSTOM_KEY: "custom-value" },
    });
    expect(out).toBe("custom-value");
  });
});

describe("redactConfig", () => {
  it("removes apiKey from config", () => {
    const r = redactConfig({ apiKey: "secret", model: "x", voice: "y" });
    expect(r).toEqual({ model: "x", voice: "y" });
    expect((r as Record<string, unknown>).apiKey).toBeUndefined();
  });
});
