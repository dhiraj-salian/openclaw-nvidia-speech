import { describe, it, expect } from "vitest";
import { FakeHttpClient } from "../http/fake-http-client.js";
import { createNvidiaMediaUnderstandingProvider } from "./media-provider.js";
import { MissingApiKeyError } from "../utils/secret-resolver.js";

const BASE = "https://1598d209-5e27-4d3c-8079-4751568b1081.invocation.api.nvcf.nvidia.com/v1";

function fakeAudio(): Buffer {
  return Buffer.from(new Uint8Array(16));
}

describe("createNvidiaMediaUnderstandingProvider", () => {
  describe("shape", () => {
    it("exposes the expected contract fields", () => {
      const provider = createNvidiaMediaUnderstandingProvider({
        http: new FakeHttpClient(),
        env: { NVIDIA_API_KEY: "k" },
      });

      expect(provider.id).toBe("nvidia");
      expect(provider.capabilities).toEqual(["audio"]);
      expect(provider.defaultModels.audio).toBe("parakeet-ctc-1.1b-en-us");
      expect(provider.autoPriority.audio).toBe(50);
      expect(typeof provider.transcribeAudio).toBe("function");
    });

    it("honors a custom defaultModel override", () => {
      const provider = createNvidiaMediaUnderstandingProvider({
        http: new FakeHttpClient(),
        env: { NVIDIA_API_KEY: "k" },
        defaultModel: "parakeet-ctc-0.6b-en",
      });

      expect(provider.defaultModels.audio).toBe("parakeet-ctc-0.6b-en");
    });
  });

  describe("transcribeAudio", () => {
    it("uses req.apiKey when provided directly", async () => {
      const fake = new FakeHttpClient();
      fake.queueResponse({ status: 200, body: { text: "hello" } });
      const provider = createNvidiaMediaUnderstandingProvider({
        http: fake,
        env: { NVIDIA_API_KEY: "env-key-should-be-ignored" },
      });

      const result = await provider.transcribeAudio({
        apiKey: "direct-key",
        buffer: fakeAudio(),
        fileName: "voice.ogg",
        mime: "audio/ogg",
        timeoutMs: 5000,
      });

      expect(result.text).toBe("hello");
      expect(result.model).toBe("parakeet-ctc-1.1b-en-us");

      const sent = fake.calls[0]!;
      expect(sent.headers["Authorization"]).toBe("Bearer direct-key");
      expect(sent.url).toBe(`${BASE}/audio/transcriptions`);
    });

    it("falls back to env when req.apiKey is empty/missing", async () => {
      const fake = new FakeHttpClient();
      fake.queueResponse({ status: 200, body: { text: "hi" } });
      const provider = createNvidiaMediaUnderstandingProvider({
        http: fake,
        env: { NVIDIA_API_KEY: "env-key" },
      });

      await provider.transcribeAudio({
        apiKey: "",
        buffer: fakeAudio(),
        fileName: "a.wav",
        mime: "audio/wav",
        timeoutMs: 5000,
      });

      expect(fake.calls[0]!.headers["Authorization"]).toBe("Bearer env-key");
    });

    it("throws MissingApiKeyError when neither req.apiKey nor env have a key", async () => {
      const fake = new FakeHttpClient();
      const provider = createNvidiaMediaUnderstandingProvider({
        http: fake,
        env: {},
      });

      await expect(
        provider.transcribeAudio({
          apiKey: "",
          buffer: fakeAudio(),
          fileName: "a.wav",
          mime: "audio/wav",
          timeoutMs: 5000,
        }),
      ).rejects.toBeInstanceOf(MissingApiKeyError);

      expect(fake.calls).toHaveLength(0);
    });

    it("respects model override from req.model (preserved in result, NOT sent on wire)", async () => {
      const fake = new FakeHttpClient();
      fake.queueResponse({ status: 200, body: { text: "ok" } });
      const provider = createNvidiaMediaUnderstandingProvider({
        http: fake,
        env: { NVIDIA_API_KEY: "k" },
      });

      const result = await provider.transcribeAudio({
        apiKey: "k",
        model: "parakeet-ctc-0.6b-en",
        buffer: fakeAudio(),
        fileName: "a.wav",
        mime: "audio/wav",
        timeoutMs: 5000,
      });

      // The chosen model is preserved on the result so callers can see what
      // they configured. It is NOT sent as a multipart field — the NVCF
      // function URL encodes the model and rejects `model=<anything>`.
      expect(result.model).toBe("parakeet-ctc-0.6b-en");
      const form = fake.calls[0]!.body;
      if (form?.kind !== "formData") throw new Error("form kind");
      expect((form.value as FormData).has("model")).toBe(false);
    });

    it("respects model override from providerConfig.sttModel when req.model absent", async () => {
      const fake = new FakeHttpClient();
      fake.queueResponse({ status: 200, body: { text: "ok" } });
      const provider = createNvidiaMediaUnderstandingProvider({
        http: fake,
        env: { NVIDIA_API_KEY: "k" },
      });

      const result = await provider.transcribeAudio({
        apiKey: "k",
        buffer: fakeAudio(),
        fileName: "a.wav",
        mime: "audio/wav",
        timeoutMs: 5000,
        providerConfig: { sttModel: "parakeet-rnnt-1.1b" },
      });

      expect(result.model).toBe("parakeet-rnnt-1.1b");
      const form = fake.calls[0]!.body;
      if (form?.kind !== "formData") throw new Error("form kind");
      expect((form.value as FormData).has("model")).toBe(false);
    });

    it("uses req.baseUrl when provided", async () => {
      const fake = new FakeHttpClient();
      fake.queueResponse({ status: 200, body: { text: "ok" } });
      const provider = createNvidiaMediaUnderstandingProvider({
        http: fake,
        env: { NVIDIA_API_KEY: "k" },
      });

      await provider.transcribeAudio({
        apiKey: "k",
        baseUrl: "https://my-proxy.example.com/nv/v1/",
        buffer: fakeAudio(),
        fileName: "a.wav",
        mime: "audio/wav",
        timeoutMs: 5000,
      });

      // Trailing slash is stripped.
      expect(fake.calls[0]!.url).toBe(
        "https://my-proxy.example.com/nv/v1/audio/transcriptions",
      );
    });

    it("falls back to providerConfig.baseUrl when req.baseUrl missing", async () => {
      const fake = new FakeHttpClient();
      fake.queueResponse({ status: 200, body: { text: "ok" } });
      const provider = createNvidiaMediaUnderstandingProvider({
        http: fake,
        env: { NVIDIA_API_KEY: "k" },
      });

      await provider.transcribeAudio({
        apiKey: "k",
        buffer: fakeAudio(),
        fileName: "a.wav",
        mime: "audio/wav",
        timeoutMs: 5000,
        providerConfig: { baseUrl: "https://proxy.example.com/v1" },
      });

      expect(fake.calls[0]!.url).toBe(
        "https://proxy.example.com/v1/audio/transcriptions",
      );
    });

    it("passes language hint through", async () => {
      const fake = new FakeHttpClient();
      fake.queueResponse({ status: 200, body: { text: "ok" } });
      const provider = createNvidiaMediaUnderstandingProvider({
        http: fake,
        env: { NVIDIA_API_KEY: "k" },
      });

      await provider.transcribeAudio({
        apiKey: "k",
        language: "en",
        buffer: fakeAudio(),
        fileName: "a.wav",
        mime: "audio/wav",
        timeoutMs: 5000,
      });

      const form = fake.calls[0]!.body;
      if (form?.kind !== "formData") throw new Error("form kind");
      expect((form.value as FormData).get("language")).toBe("en");
    });

    it("falls back to providerConfig.sttLanguage when req.language absent", async () => {
      const fake = new FakeHttpClient();
      fake.queueResponse({ status: 200, body: { text: "ok" } });
      const provider = createNvidiaMediaUnderstandingProvider({
        http: fake,
        env: { NVIDIA_API_KEY: "k" },
      });

      await provider.transcribeAudio({
        apiKey: "k",
        buffer: fakeAudio(),
        fileName: "a.wav",
        mime: "audio/wav",
        timeoutMs: 5000,
        providerConfig: { sttLanguage: "hi" },
      });

      const form = fake.calls[0]!.body;
      if (form?.kind !== "formData") throw new Error("form kind");
      expect((form.value as FormData).get("language")).toBe("hi");
    });

    it("passes prompt through", async () => {
      const fake = new FakeHttpClient();
      fake.queueResponse({ status: 200, body: { text: "ok" } });
      const provider = createNvidiaMediaUnderstandingProvider({
        http: fake,
        env: { NVIDIA_API_KEY: "k" },
      });

      await provider.transcribeAudio({
        apiKey: "k",
        prompt: "Use punctuation.",
        buffer: fakeAudio(),
        fileName: "a.wav",
        mime: "audio/wav",
        timeoutMs: 5000,
      });

      const form = fake.calls[0]!.body;
      if (form?.kind !== "formData") throw new Error("form kind");
      expect((form.value as FormData).get("prompt")).toBe("Use punctuation.");
    });

    it("uses defaultTimeoutMs when caller passes a non-positive timeoutMs", async () => {
      const fake = new FakeHttpClient();
      fake.queueResponse({ status: 200, body: { text: "ok" } });
      const provider = createNvidiaMediaUnderstandingProvider({
        http: fake,
        env: { NVIDIA_API_KEY: "k" },
        defaultTimeoutMs: 9999,
      });

      // timeoutMs: 0 is never useful for an HTTP request; the provider
      // should treat it as "use default" instead of firing an instant timeout.
      await provider.transcribeAudio({
        apiKey: "k",
        buffer: fakeAudio(),
        fileName: "a.wav",
        mime: "audio/wav",
        timeoutMs: 0,
      });

      expect(fake.calls[0]!.timeoutMs).toBe(9999);
    });

    it("uses req.timeoutMs when explicitly provided", async () => {
      const fake = new FakeHttpClient();
      fake.queueResponse({ status: 200, body: { text: "ok" } });
      const provider = createNvidiaMediaUnderstandingProvider({
        http: fake,
        env: { NVIDIA_API_KEY: "k" },
        defaultTimeoutMs: 9999,
      });

      await provider.transcribeAudio({
        apiKey: "k",
        buffer: fakeAudio(),
        fileName: "a.wav",
        mime: "audio/wav",
        timeoutMs: 1234,
      });

      expect(fake.calls[0]!.timeoutMs).toBe(1234);
    });

    it("defaults to 'application/octet-stream' when mime missing", async () => {
      const fake = new FakeHttpClient();
      fake.queueResponse({ status: 200, body: { text: "ok" } });
      const provider = createNvidiaMediaUnderstandingProvider({
        http: fake,
        env: { NVIDIA_API_KEY: "k" },
      });

      await provider.transcribeAudio({
        apiKey: "k",
        buffer: fakeAudio(),
        fileName: "blob",
        timeoutMs: 5000,
      });

      const form = fake.calls[0]!.body;
      if (form?.kind !== "formData") throw new Error("form kind");
      const blob = (form.value as FormData).get("file") as Blob;
      expect(blob.type).toBe("application/octet-stream");
    });

    it("returns the response model when server provides one", async () => {
      const fake = new FakeHttpClient();
      fake.queueResponse({
        status: 200,
        body: { text: "ok", model: "actually-used" },
      });
      const provider = createNvidiaMediaUnderstandingProvider({
        http: fake,
        env: { NVIDIA_API_KEY: "k" },
      });

      const result = await provider.transcribeAudio({
        apiKey: "k",
        buffer: fakeAudio(),
        fileName: "a.wav",
        mime: "audio/wav",
        timeoutMs: 5000,
      });

      expect(result.model).toBe("actually-used");
    });
  });
});

// ---------------------------------------------------------------------------
// Profile-fallback tests — last-resort read from shell profile files.
// ---------------------------------------------------------------------------

// Profile-fallback tests — last-resort read from shell profile files.
// ---------------------------------------------------------------------------

describe("createNvidiaMediaUnderstandingProvider — profile-fallback (last-resort)", () => {
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

  it("transcribeAudio uses profile-derived key when env + req.apiKey are empty", async () => {
    const http = new FakeHttpClient();
    http.queueResponse({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { text: "hello from profile", model: "parakeet-ctc-1.1b-en-us" },
    });
    const { profileReader } = fakeProfileReader(
      'export NVIDIA_API_KEY="nvapi-stt-from-profile"\n',
    );
    const provider = createNvidiaMediaUnderstandingProvider({
      http,
      env: {},
      profileReader,
    });

    const result = await provider.transcribeAudio({
      buffer: Buffer.from([0x52, 0x49, 0x46, 0x46]),
      fileName: "test.wav",
      mime: "audio/wav",
      apiKey: "",
      timeoutMs: 30_000,
    });

    expect(result.text).toBe("hello from profile");
    expect(http.calls[0]!.headers["Authorization"]).toBe("Bearer nvapi-stt-from-profile");
  });

  it("transcribeAudio prefers req.apiKey over profile fallback", async () => {
    const http = new FakeHttpClient();
    http.queueResponse({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { text: "direct-key", model: "parakeet" },
    });
    const { profileReader } = fakeProfileReader(
      'export NVIDIA_API_KEY="nvapi-from-profile"\n',
    );
    const provider = createNvidiaMediaUnderstandingProvider({
      http,
      env: {},
      profileReader,
    });

    await provider.transcribeAudio({
      buffer: Buffer.from([0x52, 0x49, 0x46, 0x46]),
      fileName: "test.wav",
      mime: "audio/wav",
      apiKey: "nvapi-direct",
      timeoutMs: 30_000,
    });

    expect(http.calls[0]!.headers["Authorization"]).toBe("Bearer nvapi-direct");
  });

  it("transcribeAudio throws MissingApiKeyError when nothing is available and no profile reader wired", async () => {
    const http = new FakeHttpClient();
    const provider = createNvidiaMediaUnderstandingProvider({
      http,
      env: {},
    });
    await expect(
      provider.transcribeAudio({
        buffer: Buffer.from([0x00]),
        fileName: "x.wav",
        mime: "audio/wav",
        apiKey: "",
        timeoutMs: 30_000,
      }),
    ).rejects.toBeInstanceOf(MissingApiKeyError);
  });

  it("transcribeAudio throws MissingApiKeyError when profile reader returns null", async () => {
    const http = new FakeHttpClient();
    const { profileReader } = fakeProfileReader(null);
    const provider = createNvidiaMediaUnderstandingProvider({
      http,
      env: {},
      profileReader,
    });
    await expect(
      provider.transcribeAudio({
        buffer: Buffer.from([0x00]),
        fileName: "x.wav",
        mime: "audio/wav",
        apiKey: "",
        timeoutMs: 30_000,
      }),
    ).rejects.toBeInstanceOf(MissingApiKeyError);
  });
});

// ---------------------------------------------------------------------------
// Auth-profile integration: factory accepts `cfg` / `agentDir` options.
// ---------------------------------------------------------------------------

describe("createNvidiaMediaUnderstandingProvider — cfg + agentDir factory options", () => {
  it("accepts cfg without throwing at factory build time", () => {
    const provider = createNvidiaMediaUnderstandingProvider({
      http: new FakeHttpClient(),
      cfg: { auth: { profiles: { "nvidia:default": { provider: "nvidia" } } } },
      agentDir: "/tmp/agent-1",
    });
    expect(provider.id).toBe("nvidia");
    expect(provider.capabilities).toContain("audio");
  });

  it("omitting cfg + agentDir keeps legacy behaviour", () => {
    const provider = createNvidiaMediaUnderstandingProvider({
      http: new FakeHttpClient(),
    });
    expect(provider.id).toBe("nvidia");
  });

  it("explicit req.apiKey wins over cfg + env", async () => {
    const http = new FakeHttpClient();
    http.queueResponse({
      status: 200,
      body: { text: "ok", model: "parakeet-x" },
      headers: { "content-type": "application/json" },
    });
    const provider = createNvidiaMediaUnderstandingProvider({
      http,
      cfg: { auth: { profiles: { "nvidia:default": { provider: "nvidia" } } } } as never,
      env: { NVIDIA_API_KEY: "***" },
    });
    await provider.transcribeAudio({
      buffer: Buffer.from([0x00]),
      fileName: "x.wav",
      mime: "audio/wav",
      apiKey: "req-wins",
      timeoutMs: 30_000,
    });
    expect(http.calls[0]!.headers["Authorization"]).toBe("Bearer req-wins");
  });

  it("falls back to env when cfg is present but no apiKey is resolvable from it", async () => {
    const http = new FakeHttpClient();
    http.queueResponse({
      status: 200,
      body: { text: "ok", model: "parakeet-x" },
      headers: { "content-type": "application/json" },
    });
    const provider = createNvidiaMediaUnderstandingProvider({
      http,
      cfg: { auth: { profiles: { "nvidia:default": { provider: "nvidia" } } } } as never,
      env: { NVIDIA_API_KEY: "from-env-fallback" },
    });
    await provider.transcribeAudio({
      buffer: Buffer.from([0x00]),
      fileName: "x.wav",
      mime: "audio/wav",
      apiKey: "",
      timeoutMs: 30_000,
    });
    expect(http.calls[0]!.headers["Authorization"]).toBe("Bearer from-env-fallback");
  });
});

// ---------------------------------------------------------------------------
// Race condition: transcribeAudio called before eager resolve completes.
// Bug discovered 2026-06-24 — first STT call after register() threw
// MissingApiKeyError because `getApiKey` fell through to the legacy
// resolveApiKey chain before the cached async resolver had populated.
// Fix: `getApiKey` is now async and awaits the cached resolver on miss.
// ---------------------------------------------------------------------------

describe("createNvidiaMediaUnderstandingProvider — race condition (cache-cold first call)", () => {
  // Local copy of the fake profile reader so this describe block is
  // self-contained (the `fakeProfileReader` helper from the
  // profile-fallback describe above is not in scope here).
  function fakeProfileReaderForRace(contents: string | null): {
    profileReader: { os: { homedir: () => string }; fs: { existsSync: () => boolean; readFileSync: () => string } };
  } {
    return {
      profileReader: {
        os: { homedir: () => "/home/fake" },
        fs: {
          existsSync: () => contents !== null,
          readFileSync: () => contents ?? "",
        },
      },
    };
  }

  it("transcribeAudio awaits the resolver when called before eager resolve completes", async () => {
    // Bug repro: first call after register() with no env key. Pre-fix,
    // getApiKey() would peek() → undefined → fall through to legacy
    // resolveApiKey → throw MissingApiKeyError in ~1ms.
    // Post-fix: getApiKey() awaits the cached resolver on miss.
    const http = new FakeHttpClient();
    http.queueResponse({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { text: "race-passed", model: "parakeet-ctc-1.1b-en-us" },
    });

    // Wire a profileReader that returns a key. The async resolver will
    // (1) check env (empty), (2) check shell profile (returns key) and
    // cache it. getApiKey awaits this on cache miss.
    const { profileReader } = fakeProfileReaderForRace('export NVIDIA_API_KEY="nvapi-from-resolver"\n');
    const provider = createNvidiaMediaUnderstandingProvider({
      http,
      env: {},
      profileReader,
    });

    // No `await` between factory and call — fire immediately, just like
    // the gateway does when a WhatsApp voice memo lands right after boot.
    const result = await provider.transcribeAudio({
      buffer: Buffer.from([0x00]),
      fileName: "race.wav",
      mime: "audio/wav",
      apiKey: "",
      timeoutMs: 30_000,
    });

    expect(result.text).toBe("race-passed");
    expect(http.calls[0]!.headers["Authorization"]).toBe(
      "Bearer nvapi-from-resolver",
    );
  });

  it("transcribeAudio resolves via env when present (smoke against the env path)", async () => {
    // Belt-and-braces: confirms the env path still works after the
    // async-await refactor.
    const http = new FakeHttpClient();
    http.queueResponse({
      status: 200,
      headers: { "content-type": "application/json" },
      body: { text: "no-race", model: "parakeet-ctc-1.1b-en-us" },
    });

    const provider = createNvidiaMediaUnderstandingProvider({
      http,
      env: { NVIDIA_API_KEY: "nvapi-resolved" },
    });

    const result = await provider.transcribeAudio({
      buffer: Buffer.from([0x00]),
      fileName: "race.wav",
      mime: "audio/wav",
      apiKey: "",
      timeoutMs: 30_000,
    });

    expect(result.text).toBe("no-race");
  });
});

// ---------------------------------------------------------------------------
// isConfigured: synchronous probe for runtime's
// isCapabilityProviderConfigured / auto-fallback selection.
// Mirrors the TTS provider's isConfigured. Required because the runtime
// calls isConfigured sync (no await).
// ---------------------------------------------------------------------------

describe("createNvidiaMediaUnderstandingProvider — isConfigured (sync)", () => {
  function localFakeProfileReader(contents: string | null): {
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

  it("returns false when nothing is configured", () => {
    const provider = createNvidiaMediaUnderstandingProvider({
      http: new FakeHttpClient(),
      env: {},
    });
    expect(provider.isConfigured({})).toBe(false);
  });

  it("returns true when env has NVIDIA_API_KEY", () => {
    const provider = createNvidiaMediaUnderstandingProvider({
      http: new FakeHttpClient(),
      env: { NVIDIA_API_KEY: "k" },
    });
    expect(provider.isConfigured({})).toBe(true);
  });

  it("returns true when providerConfig.apiKey is provided", () => {
    const provider = createNvidiaMediaUnderstandingProvider({
      http: new FakeHttpClient(),
      env: {},
    });
    expect(provider.isConfigured({ providerConfig: { apiKey: "k" } })).toBe(true);
  });

  it("returns true when providerConfig.apiKey is a SecretRef-like object", () => {
    const provider = createNvidiaMediaUnderstandingProvider({
      http: new FakeHttpClient(),
      env: {},
    });
    expect(
      provider.isConfigured({ providerConfig: { apiKey: { value: "k" } } }),
    ).toBe(true);
  });

  it("returns true when shell profile has the key (profileReader wired)", () => {
    const { profileReader } = localFakeProfileReader('export NVIDIA_API_KEY="k"\n');
    const provider = createNvidiaMediaUnderstandingProvider({
      http: new FakeHttpClient(),
      env: {},
      profileReader,
    });
    expect(provider.isConfigured({})).toBe(true);
  });

  it("returns false when profileReader returns null and env empty", () => {
    const { profileReader } = localFakeProfileReader(null);
    const provider = createNvidiaMediaUnderstandingProvider({
      http: new FakeHttpClient(),
      env: {},
      profileReader,
    });
    expect(provider.isConfigured({})).toBe(false);
  });

  it("ignores empty-string providerConfig.apiKey", () => {
    const provider = createNvidiaMediaUnderstandingProvider({
      http: new FakeHttpClient(),
      env: {},
    });
    expect(provider.isConfigured({ providerConfig: { apiKey: "   " } })).toBe(false);
  });

  it("works without a ctx argument (defensive default)", () => {
    const provider = createNvidiaMediaUnderstandingProvider({
      http: new FakeHttpClient(),
      env: { NVIDIA_API_KEY: "k" },
    });
    expect(provider.isConfigured()).toBe(true);
  });
});
