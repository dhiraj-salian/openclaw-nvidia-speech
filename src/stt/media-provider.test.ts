import { describe, it, expect } from "vitest";
import { FakeHttpClient } from "../http/fake-http-client.js";
import { createNvidiaMediaUnderstandingProvider } from "./media-provider.js";
import { MissingApiKeyError } from "../utils/secret-resolver.js";

const BASE = "https://integrate.api.nvidia.com/v1";

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
      expect(provider.defaultModels.audio).toBe("parakeet-ctc-1.1b-en-multilingual");
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
      expect(result.model).toBe("parakeet-ctc-1.1b-en-multilingual");

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

    it("respects model override from req.model", async () => {
      const fake = new FakeHttpClient();
      fake.queueResponse({ status: 200, body: { text: "ok" } });
      const provider = createNvidiaMediaUnderstandingProvider({
        http: fake,
        env: { NVIDIA_API_KEY: "k" },
      });

      await provider.transcribeAudio({
        apiKey: "k",
        model: "parakeet-ctc-0.6b-en",
        buffer: fakeAudio(),
        fileName: "a.wav",
        mime: "audio/wav",
        timeoutMs: 5000,
      });

      const form = fake.calls[0]!.body;
      if (form?.kind !== "formData") throw new Error("form kind");
      expect((form.value as FormData).get("model")).toBe("parakeet-ctc-0.6b-en");
    });

    it("respects model override from providerConfig.sttModel when req.model absent", async () => {
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
        providerConfig: { sttModel: "parakeet-rnnt-1.1b" },
      });

      const form = fake.calls[0]!.body;
      if (form?.kind !== "formData") throw new Error("form kind");
      expect((form.value as FormData).get("model")).toBe("parakeet-rnnt-1.1b");
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
      body: { text: "hello from profile", model: "parakeet-ctc-1.1b-en-multilingual" },
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
