import { describe, it, expect } from "vitest";
import {
  normalizeRawConfig,
  asNvidiaAudioFormat,
  asNvidiaSampleRate,
  asFiniteInteger,
  asNonEmptyString,
  assertValidHttpUrl,
} from "./schema.js";
import {
  NVIDIA_DEFAULT_TTS_MODEL,
  NVIDIA_DEFAULT_TTS_VOICE,
  NVIDIA_DEFAULT_TTS_LANGUAGE,
  NVIDIA_DEFAULT_STT_MODEL,
  NVIDIA_DEFAULT_BASE_URL,
} from "./defaults.js";

describe("asNonEmptyString", () => {
  it("returns trimmed string for valid input", () => {
    expect(asNonEmptyString("  hi  ")).toBe("hi");
  });
  it("returns undefined for empty/whitespace", () => {
    expect(asNonEmptyString("")).toBeUndefined();
    expect(asNonEmptyString("   ")).toBeUndefined();
  });
  it("returns undefined for non-strings", () => {
    expect(asNonEmptyString(42)).toBeUndefined();
    expect(asNonEmptyString(null)).toBeUndefined();
    expect(asNonEmptyString(undefined)).toBeUndefined();
  });
});

describe("asFiniteInteger", () => {
  it("accepts finite integers", () => {
    expect(asFiniteInteger(42)).toBe(42);
  });
  it("rejects floats, Infinity, NaN", () => {
    expect(asFiniteInteger(1.5)).toBeUndefined();
    expect(asFiniteInteger(Infinity)).toBeUndefined();
    expect(asFiniteInteger(NaN)).toBeUndefined();
  });
});

describe("asNvidiaAudioFormat", () => {
  it("accepts supported formats case-insensitively", () => {
    expect(asNvidiaAudioFormat("WAV")).toBe("wav");
    expect(asNvidiaAudioFormat("opus")).toBe("opus");
  });
  it("rejects unsupported", () => {
    expect(asNvidiaAudioFormat("wma")).toBeUndefined();
    expect(asNvidiaAudioFormat("")).toBeUndefined();
  });
});

describe("asNvidiaSampleRate", () => {
  it("accepts supported sample rates", () => {
    expect(asNvidiaSampleRate(22050)).toBe(22050);
    expect(asNvidiaSampleRate(48000)).toBe(48000);
  });
  it("rejects unsupported", () => {
    expect(asNvidiaSampleRate(11025)).toBeUndefined();
    expect(asNvidiaSampleRate(22050.5)).toBeUndefined();
  });
});

describe("assertValidHttpUrl", () => {
  it("accepts https URLs", () => {
    expect(() => assertValidHttpUrl("https://api.example.com/v1", "test")).not.toThrow();
  });
  it("throws on non-http schemes", () => {
    expect(() => assertValidHttpUrl("file:///etc/passwd", "test")).toThrow(/http\(s\)/);
  });
  it("throws on garbage", () => {
    expect(() => assertValidHttpUrl("not a url", "test")).toThrow(/not a valid URL/);
  });
});

describe("normalizeRawConfig", () => {
  it("applies all defaults when given empty object", () => {
    const out = normalizeRawConfig({});
    expect(out.baseUrl).toBe(NVIDIA_DEFAULT_BASE_URL);
    expect(out.tts.model).toBe(NVIDIA_DEFAULT_TTS_MODEL);
    expect(out.tts.defaultVoice).toBe(NVIDIA_DEFAULT_TTS_VOICE);
    expect(out.tts.defaultLanguage).toBe(NVIDIA_DEFAULT_TTS_LANGUAGE);
    expect(out.tts.defaultFormat).toBe("wav");
    expect(out.stt.model).toBe(NVIDIA_DEFAULT_STT_MODEL);
    expect(out.stt.defaultLanguage).toBeUndefined();
  });

  it("uses provided overrides", () => {
    const out = normalizeRawConfig({
      baseUrl: "https://custom.example.com/v2",
      model: "custom-tts",
      voice: "CustomVoice",
      language: "hi-IN",
      sampleRate: 16000,
      format: "mp3",
      sttModel: "custom-stt",
      sttLanguage: "hi-IN",
    });
    expect(out.baseUrl).toBe("https://custom.example.com/v2");
    expect(out.tts.model).toBe("custom-tts");
    expect(out.tts.defaultVoice).toBe("CustomVoice");
    expect(out.tts.defaultLanguage).toBe("hi-IN");
    expect(out.tts.defaultSampleRate).toBe(16000);
    expect(out.tts.defaultFormat).toBe("mp3");
    expect(out.stt.model).toBe("custom-stt");
    expect(out.stt.defaultLanguage).toBe("hi-IN");
  });

  it("throws on invalid baseUrl", () => {
    expect(() => normalizeRawConfig({ baseUrl: "file:///x" })).toThrow(/not a valid URL|http\(s\)/);
  });

  it("ignores invalid sampleRate and falls back to default", () => {
    const out = normalizeRawConfig({ sampleRate: 11025 });
    expect(out.tts.defaultSampleRate).toBe(22050);
  });

  it("ignores invalid format and falls back to default", () => {
    const out = normalizeRawConfig({ format: "wma" });
    expect(out.tts.defaultFormat).toBe("wav");
  });

  it("treats null/undefined raw config as empty", () => {
    expect(normalizeRawConfig(null).tts.model).toBe(NVIDIA_DEFAULT_TTS_MODEL);
    expect(normalizeRawConfig(undefined).tts.model).toBe(NVIDIA_DEFAULT_TTS_MODEL);
  });
});
