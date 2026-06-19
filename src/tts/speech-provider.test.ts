/**
 * Tests for `speech-provider.ts` — the SpeechProviderPlugin shape we hand to
 * OpenClaw. Mirrors the bundled elevenlabs plugin's contract surface:
 *
 *   - factory returns SpeechProviderPlugin shape
 *   - id/label/defaultModel/models exposed
 *   - isConfigured reads env + providerConfig.apiKey
 *   - synthesize wires NvidiaTtsClient and returns SpeechSynthesisResult
 *   - parseDirectiveToken handles inline `voice:` / `model:` / `lang:` / `format:`
 *   - listVoices proxies to VoicesClient
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  NVIDIA_DEFAULT_TTS_LANGUAGE,
  NVIDIA_DEFAULT_TTS_MODEL,
  NVIDIA_DEFAULT_TTS_SAMPLE_RATE,
  NVIDIA_DEFAULT_TTS_VOICE,
  NVIDIA_DEFAULT_BASE_URL,
} from "../config/defaults.js";
import { FakeHttpClient } from "../http/fake-http-client.js";
import { MissingApiKeyError } from "../utils/secret-resolver.js";
import { createNvidiaSpeechProvider } from "./speech-provider.js";

// Minimal stand-in for OpenClawConfig — only the bits our provider reads.
const makeCfg = () => ({} as unknown as Record<string, unknown>);

// Minimal SpeechSynthesisRequest factory.
function makeSynthReq(overrides: {
  text?: string;
  providerConfig?: Record<string, unknown>;
  providerOverrides?: Record<string, unknown>;
  timeoutMs?: number;
}) {
  return {
    text: "Hello world",
    cfg: makeCfg() as unknown as never,
    providerConfig: (overrides.providerConfig ?? {}) as unknown as Record<string, unknown>,
    target: { kind: "voice-note" as const },
    timeoutMs: overrides.timeoutMs ?? 30000,
    ...(overrides.providerOverrides
      ? { providerOverrides: overrides.providerOverrides as unknown as Record<string, unknown> }
      : {}),
  } as unknown as Parameters<ReturnType<typeof createNvidiaSpeechProvider>["synthesize"]>[0];
}

describe("createNvidiaSpeechProvider — factory shape", () => {
  it("returns a SpeechProviderPlugin with the expected id and label", () => {
    const provider = createNvidiaSpeechProvider({ http: new FakeHttpClient() });
    expect(provider.id).toBe("nvidia");
    expect(typeof provider.label).toBe("string");
    expect(provider.label.length).toBeGreaterThan(0);
  });

  it("exposes NVIDIA defaults", () => {
    const provider = createNvidiaSpeechProvider({ http: new FakeHttpClient() });
    expect(provider.defaultModel).toBe(NVIDIA_DEFAULT_TTS_MODEL);
    expect(provider.defaultTimeoutMs).toBeGreaterThan(0);
    expect(Array.isArray(provider.models)).toBe(true);
    expect((provider.models ?? []).length).toBeGreaterThan(0);
    expect(provider.models).toContain(NVIDIA_DEFAULT_TTS_MODEL);
  });

  it("has isConfigured and synthesize as functions (required by contract)", () => {
    const provider = createNvidiaSpeechProvider({ http: new FakeHttpClient() });
    expect(typeof provider.isConfigured).toBe("function");
    expect(typeof provider.synthesize).toBe("function");
  });

  it("optionally exposes parseDirectiveToken and listVoices", () => {
    const provider = createNvidiaSpeechProvider({ http: new FakeHttpClient() });
    expect(typeof provider.parseDirectiveToken).toBe("function");
    expect(typeof provider.listVoices).toBe("function");
  });
});

describe("createNvidiaSpeechProvider — isConfigured", () => {
  it("returns true when apiKey is in providerConfig", () => {
    const provider = createNvidiaSpeechProvider({ http: new FakeHttpClient() });
    expect(
      provider.isConfigured({
        providerConfig: { apiKey: "nvapi-xyz" },
        timeoutMs: 30000,
      } as unknown as Parameters<typeof provider.isConfigured>[0]),
    ).toBe(true);
  });

  it("returns true when NVIDIA_API_KEY env is set", () => {
    const provider = createNvidiaSpeechProvider({
      http: new FakeHttpClient(),
      env: { NVIDIA_API_KEY: "from-env" },
    });
    expect(
      provider.isConfigured({
        providerConfig: {},
        timeoutMs: 30000,
      } as unknown as Parameters<typeof provider.isConfigured>[0]),
    ).toBe(true);
  });

  it("returns false when no apiKey anywhere", () => {
    const provider = createNvidiaSpeechProvider({
      http: new FakeHttpClient(),
      env: {},
    });
    expect(
      provider.isConfigured({
        providerConfig: {},
        timeoutMs: 30000,
      } as unknown as Parameters<typeof provider.isConfigured>[0]),
    ).toBe(false);
  });

  it("returns false when apiKey is empty/whitespace string", () => {
    const provider = createNvidiaSpeechProvider({
      http: new FakeHttpClient(),
      env: {},
    });
    expect(
      provider.isConfigured({
        providerConfig: { apiKey: "   " },
        timeoutMs: 30000,
      } as unknown as Parameters<typeof provider.isConfigured>[0]),
    ).toBe(false);
  });
});

describe("createNvidiaSpeechProvider — synthesize (happy path)", () => {
  let fake: FakeHttpClient;
  let provider: ReturnType<typeof createNvidiaSpeechProvider>;

  beforeEach(() => {
    fake = new FakeHttpClient();
    provider = createNvidiaSpeechProvider({ http: fake });
  });

  it("POSTs to {baseUrl}/audio/synthesize with defaults", async () => {
    fake.queueResponse({
      status: 200,
      headers: { "content-type": "audio/wav" },
      body: new Uint8Array([0x52, 0x49, 0x46, 0x46]),
    });

    await provider.synthesize(
      makeSynthReq({
        providerConfig: { apiKey: "nvapi-1", baseUrl: NVIDIA_DEFAULT_BASE_URL },
      }),
    );

    expect(fake.calls).toHaveLength(1);
    const sent = fake.calls[0]!;
    expect(sent.url).toBe(`${NVIDIA_DEFAULT_BASE_URL}/audio/synthesize`);
    expect(sent.method).toBe("POST");
    expect(sent.headers["Authorization"]).toBe("Bearer nvapi-1");

    const body = sent.body as { kind: "json"; value: Record<string, unknown> };
    expect(body.kind).toBe("json");
    expect(body.value.text).toBe("Hello world");
    expect(body.value.voice_name).toBe(NVIDIA_DEFAULT_TTS_VOICE);
    expect(body.value.model).toBe(NVIDIA_DEFAULT_TTS_MODEL);
    expect(body.value.language_code).toBe(NVIDIA_DEFAULT_TTS_LANGUAGE);
    expect(body.value.sample_rate_hz).toBe(NVIDIA_DEFAULT_TTS_SAMPLE_RATE);
  });

  it("returns SpeechSynthesisResult with Buffer + voice metadata", async () => {
    fake.queueResponse({
      status: 200,
      headers: { "content-type": "audio/mpeg" },
      body: new Uint8Array([0xff, 0xfb, 0x90, 0x44]),
    });

    const result = await provider.synthesize(
      makeSynthReq({
        text: "ping",
        providerConfig: { apiKey: "nvapi-1", format: "mp3" },
      }),
    );

    expect(Buffer.isBuffer(result.audioBuffer)).toBe(true);
    expect(result.audioBuffer.byteLength).toBe(4);
    expect(result.outputFormat).toBe("audio/mpeg");
    expect(result.fileExtension).toBe("mp3");
    expect(typeof result.voiceCompatible).toBe("boolean");
  });

  it("applies providerOverrides (voice/model/lang/format) over defaults", async () => {
    fake.queueResponse({
      status: 200,
      headers: { "content-type": "audio/wav" },
      body: new Uint8Array([0x00]),
    });

    await provider.synthesize(
      makeSynthReq({
        providerConfig: { apiKey: "nvapi-1" },
        providerOverrides: {
          voice: "Custom.Voice",
          model: "magpie-tts-multilingual",
          language: "hi-IN",
          format: "flac",
          sampleRate: 48000,
        },
      }),
    );

    const body = fake.calls[0]!.body as { kind: "json"; value: Record<string, unknown> };
    expect(body.value.voice_name).toBe("Custom.Voice");
    expect(body.value.language_code).toBe("hi-IN");
    expect(body.value.audio_format).toBe("flac");
    expect(body.value.sample_rate_hz).toBe(48000);
  });

  it("falls back to NVIDIA_API_KEY env when providerConfig has no apiKey", async () => {
    fake.queueResponse({
      status: 200,
      headers: { "content-type": "audio/wav" },
      body: new Uint8Array([0]),
    });

    const providerWithEnv = createNvidiaSpeechProvider({
      http: fake,
      env: { NVIDIA_API_KEY: "env-key" },
    });
    await providerWithEnv.synthesize(makeSynthReq({ providerConfig: {} }));

    expect(fake.calls[0]!.headers["Authorization"]).toBe("Bearer env-key");
  });

  it("passes timeoutMs through to HttpClient", async () => {
    fake.queueResponse({ status: 200, body: new Uint8Array([0]) });

    await provider.synthesize(
      makeSynthReq({ providerConfig: { apiKey: "k" }, timeoutMs: 7500 }),
    );

    expect(fake.calls[0]!.timeoutMs).toBe(7500);
  });

  it("rejects with MissingApiKeyError when no key in config or env", async () => {
    const providerNoKey = createNvidiaSpeechProvider({ http: fake, env: {} });
    await expect(
      providerNoKey.synthesize(makeSynthReq({ providerConfig: {} })),
    ).rejects.toBeInstanceOf(MissingApiKeyError);
    expect(fake.calls).toHaveLength(0);
  });

  it("propagates HTTP errors from the underlying client", async () => {
    fake.queueResponse({ status: 500, body: "boom" });
    await expect(
      provider.synthesize(makeSynthReq({ providerConfig: { apiKey: "k" } })),
    ).rejects.toThrow();
  });
});

describe("createNvidiaSpeechProvider — parseDirectiveToken", () => {
  const makeCtx = (
    key: string,
    value: string,
    overrides?: { policy?: Record<string, unknown>; providerConfig?: Record<string, unknown> },
  ) =>
    ({
      key,
      value,
      policy: {
        enabled: true,
        allowText: false,
        allowProvider: false,
        allowVoice: true,
        allowModelId: true,
        allowVoiceSettings: true,
        allowNormalization: false,
        allowSeed: false,
        ...(overrides?.policy ?? {}),
      },
      ...(overrides?.providerConfig ? { providerConfig: overrides.providerConfig } : {}),
    }) as unknown as Parameters<
      NonNullable<ReturnType<typeof createNvidiaSpeechProvider>["parseDirectiveToken"]>
    >[0];

  const provider = createNvidiaSpeechProvider({ http: new FakeHttpClient() });

  it("returns handled=true with overrides for known keys", () => {
    const voiceResult = provider.parseDirectiveToken!(makeCtx("voice", "Aria"));
    expect(voiceResult.handled).toBe(true);
    expect(voiceResult.overrides?.voice).toBe("Aria");

    const modelResult = provider.parseDirectiveToken!(makeCtx("model", "magpie-tts-multilingual"));
    expect(modelResult.handled).toBe(true);
    expect(modelResult.overrides?.model).toBe("magpie-tts-multilingual");

    const langResult = provider.parseDirectiveToken!(makeCtx("lang", "hi-IN"));
    expect(langResult.handled).toBe(true);
    expect(langResult.overrides?.language).toBe("hi-IN");

    const formatResult = provider.parseDirectiveToken!(makeCtx("format", "mp3"));
    expect(formatResult.handled).toBe(true);
    expect(formatResult.overrides?.format).toBe("mp3");
  });

  it("returns handled=false for unknown keys", () => {
    const result = provider.parseDirectiveToken!(makeCtx("notarealkey", "value"));
    expect(result.handled).toBe(false);
  });

  it("returns handled=false when policy blocks voice overrides", () => {
    const provider2 = createNvidiaSpeechProvider({ http: new FakeHttpClient() });
    const result = provider2.parseDirectiveToken!(
      makeCtx("voice", "Aria", { policy: { allowVoice: false } }),
    );
    expect(result.handled).toBe(false);
  });

  it("rejects unsupported format values", () => {
    const result = provider.parseDirectiveToken!(makeCtx("format", "wma"));
    expect(result.handled).toBe(false);
    expect(result.warnings?.[0]).toMatch(/format/i);
  });

  it("rejects unsupported sampleRate values", () => {
    const result = provider.parseDirectiveToken!(makeCtx("sampleRate", "11025"));
    expect(result.handled).toBe(false);
    expect(result.warnings?.[0]).toMatch(/sample/i);
  });
});

describe("createNvidiaSpeechProvider — listVoices", () => {
  it("proxies to VoicesClient and returns SpeechVoiceOption[]", async () => {
    const fake = new FakeHttpClient();
    fake.queueResponse({
      status: 200,
      headers: { "content-type": "application/json" },
      body: {
        voices: [
          { voice_id: "Aria", language_code: "en-US", gender: "female" },
          { voice_id: "Bram", language_code: "en-GB", gender: "male" },
        ],
      },
    });
    const provider = createNvidiaSpeechProvider({ http: fake });

    const voices = await provider.listVoices!({
      providerConfig: { apiKey: "k" },
    } as unknown as Parameters<NonNullable<typeof provider.listVoices>>[0]);

    expect(voices).toHaveLength(2);
    expect(voices[0]?.id).toBe("Aria");
    expect(voices[0]?.gender).toBe("female");
    expect(voices[1]?.id).toBe("Bram");
  });
});

// ---------------------------------------------------------------------------
// Profile-fallback tests — last-resort read from shell profile files.
// ---------------------------------------------------------------------------

describe("createNvidiaSpeechProvider — profile-fallback (last-resort)", () => {
  function fakeProfileReader(contents: string | null): {
    profileReader: { os: { homedir: () => string }; fs: { existsSync: () => boolean; readFileSync: () => string } };
  } {
    const profileReader = {
      os: { homedir: () => "/home/fake" },
      fs: {
        existsSync: () => contents !== null,
        readFileSync: () => (contents ?? ""),
      },
    };
    return { profileReader };
  }

  beforeEach(() => {
    process.env.NVIDIA_API_KEY = "";
  });

  it("isConfigured returns true when profile contains NVIDIA_API_KEY and env is empty", () => {
    const { profileReader } = fakeProfileReader(
      'export NVIDIA_API_KEY="nvapi-from-profile"\n',
    );
    const provider = createNvidiaSpeechProvider({
      http: new FakeHttpClient(),
      env: {},
      profileReader,
    });
    expect(
      provider.isConfigured({
        providerConfig: {},
        timeoutMs: 30_000,
      } as unknown as Parameters<typeof provider.isConfigured>[0]),
    ).toBe(true);
  });

  it("isConfigured returns false when no apiKey anywhere AND no profile reader wired", () => {
    const provider = createNvidiaSpeechProvider({
      http: new FakeHttpClient(),
      env: {},
      // no profileReader
    });
    expect(
      provider.isConfigured({
        providerConfig: {},
        timeoutMs: 30_000,
      } as unknown as Parameters<typeof provider.isConfigured>[0]),
    ).toBe(false);
  });

  it("synthesize uses profile-derived key when env + config are empty", async () => {
    const http = new FakeHttpClient();
    http.queueResponse({
      status: 200,
      headers: { "content-type": "audio/wav" },
      body: new Uint8Array([0x52, 0x49, 0x46, 0x46]), // "RIFF" magic
    });
    const { profileReader } = fakeProfileReader(
      'export NVIDIA_API_KEY="nvapi-from-profile"\n',
    );
    const provider = createNvidiaSpeechProvider({
      http,
      env: {},
      profileReader,
    });

    await provider.synthesize({
      text: "hello from profile",
      cfg: undefined,
      providerConfig: {},
      target: { kind: "test" },
      timeoutMs: 30_000,
    } as unknown as Parameters<typeof provider.synthesize>[0]);

    const sent = http.calls[0]!;
    expect(sent.headers["Authorization"]).toBe("Bearer nvapi-from-profile");
  });

  it("synthesize prefers env over profile when both are set", async () => {
    const http = new FakeHttpClient();
    http.queueResponse({
      status: 200,
      headers: { "content-type": "audio/wav" },
      body: new Uint8Array([0x52, 0x49, 0x46, 0x46]),
    });
    http.queueResponse({
      status: 200,
      headers: { "content-type": "audio/wav" },
      body: new Uint8Array([0x52, 0x49, 0x46, 0x46]),
    });
    const { profileReader } = fakeProfileReader(
      'export NVIDIA_API_KEY="nvapi-from-profile"\n',
    );
    const provider = createNvidiaSpeechProvider({
      http,
      env: { NVIDIA_API_KEY: "nvapi-from-env" },
      profileReader,
    });

    await provider.synthesize({
      text: "hi",
      cfg: undefined,
      providerConfig: {},
      target: { kind: "test" },
      timeoutMs: 30_000,
    } as unknown as Parameters<typeof provider.synthesize>[0]);

    expect(http.calls[0]!.headers["Authorization"]).toBe("Bearer nvapi-from-env");
  });

  it("listVoices uses profile-derived key when env + config are empty", async () => {
    const http = new FakeHttpClient();
    http.queueResponse({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { voices: [{ voice_id: "Aria", language_code: "en-US", gender: "female" }] },
    });
    const { profileReader } = fakeProfileReader(
      'export NVIDIA_API_KEY="nvapi-profile-voices"\n',
    );
    const provider = createNvidiaSpeechProvider({
      http,
      env: {},
      profileReader,
    });

    const voices = await provider.listVoices!({} as Parameters<NonNullable<typeof provider.listVoices>>[0]);
    expect(voices[0]?.id).toBe("Aria");
    expect(http.calls[0]!.headers["Authorization"]).toBe("Bearer nvapi-profile-voices");
  });
});
