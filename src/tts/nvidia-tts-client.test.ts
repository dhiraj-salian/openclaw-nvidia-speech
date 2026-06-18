import { describe, it, expect } from "vitest";
import { FakeHttpClient } from "../http/fake-http-client.js";
import { NvidiaTtsClient } from "./nvidia-tts-client.js";
import { NvSpeechError } from "../http/errors.js";

describe("NvidiaTtsClient.synthesize", () => {
  const BASE = "https://integrate.api.nvidia.com/v1";

  it("POSTs to {baseUrl}/audio/synthesize with correct shape and bearer auth", async () => {
    const fake = new FakeHttpClient();
    fake.queueResponse({
      status: 200,
      headers: { "content-type": "audio/wav" },
      body: new Uint8Array([1, 2, 3, 4]),
    });
    const client = new NvidiaTtsClient(fake);

    const result = await client.synthesize({
      apiKey: "nvapi-test",
      baseUrl: BASE,
      model: "magpie-tts-multilingual",
      text: "Hello world",
      voiceName: "Magpie-Multilingual.EN-US.Aria",
      languageCode: "en-US",
      audioFormat: "wav",
      sampleRateHz: 22050,
    });

    expect(result.audio.byteLength).toBe(4);
    expect(result.contentType).toBe("audio/wav");
    expect(result.fileExtension).toBe("wav");

    const sent = fake.calls[0]!;
    expect(sent.url).toBe(`${BASE}/audio/synthesize`);
    expect(sent.method).toBe("POST");
    expect(sent.headers["Authorization"]).toBe("Bearer nvapi-test");
    expect(sent.headers["Accept"]).toBe("audio/wav");
    expect(sent.body).toEqual({
      kind: "json",
      value: {
        model: "magpie-tts-multilingual",
        text: "Hello world",
        voice_name: "Magpie-Multilingual.EN-US.Aria",
        language_code: "en-US",
        audio_format: "wav",
        sample_rate_hz: 22050,
        encoding: "LINEAR16",
      },
    });
  });

  it("returns mp3 fileExtension when server returns audio/mpeg", async () => {
    const fake = new FakeHttpClient();
    fake.queueResponse({
      status: 200,
      headers: { "content-type": "audio/mpeg" },
      body: new Uint8Array([0xff, 0xfb]),
    });
    const client = new NvidiaTtsClient(fake);

    const result = await client.synthesize({
      apiKey: "k",
      baseUrl: BASE,
      model: "m",
      text: "hi",
      voiceName: "v",
      languageCode: "en-US",
      audioFormat: "mp3",
      sampleRateHz: 22050,
    });

    expect(result.fileExtension).toBe("mp3");
  });

  it("respects timeoutMs", async () => {
    const fake = new FakeHttpClient();
    fake.queueResponse({ status: 200, body: new Uint8Array([]) });
    const client = new NvidiaTtsClient(fake);

    await client.synthesize({
      apiKey: "k",
      baseUrl: BASE,
      model: "m",
      text: "hi",
      voiceName: "v",
      languageCode: "en-US",
      audioFormat: "wav",
      sampleRateHz: 22050,
      timeoutMs: 1234,
    });

    expect(fake.calls[0]?.timeoutMs).toBe(1234);
  });

  it("rejects empty text before HTTP call", async () => {
    const fake = new FakeHttpClient();
    const client = new NvidiaTtsClient(fake);

    await expect(
      client.synthesize({
        apiKey: "k",
        baseUrl: BASE,
        model: "m",
        text: "   ",
        voiceName: "v",
        languageCode: "en-US",
        audioFormat: "wav",
        sampleRateHz: 22050,
      }),
    ).rejects.toThrow(/text is required/);

    expect(fake.calls).toHaveLength(0);
  });

  it("rejects missing apiKey", async () => {
    const fake = new FakeHttpClient();
    const client = new NvidiaTtsClient(fake);

    await expect(
      client.synthesize({
        apiKey: "",
        baseUrl: BASE,
        model: "m",
        text: "hi",
        voiceName: "v",
        languageCode: "en-US",
        audioFormat: "wav",
        sampleRateHz: 22050,
      }),
    ).rejects.toThrow(/apiKey is required/);
  });

  it("surfaces NvSpeechError on auth failure (401)", async () => {
    const fake = new FakeHttpClient();
    fake.queueResponse(new NvSpeechError("no auth", { kind: "auth", status: 401 }));
    const client = new NvidiaTtsClient(fake);

    await expect(
      client.synthesize({
        apiKey: "bad",
        baseUrl: BASE,
        model: "m",
        text: "hi",
        voiceName: "v",
        languageCode: "en-US",
        audioFormat: "wav",
        sampleRateHz: 22050,
      }),
    ).rejects.toMatchObject({ kind: "auth" });
  });

  it("captures requestId from response header", async () => {
    const fake = new FakeHttpClient();
    fake.queueResponse({
      status: 200,
      headers: { "content-type": "audio/wav", "x-request-id": "abc-123" },
      body: new Uint8Array([1]),
    });
    const client = new NvidiaTtsClient(fake);

    const result = await client.synthesize({
      apiKey: "k",
      baseUrl: BASE,
      model: "m",
      text: "hi",
      voiceName: "v",
      languageCode: "en-US",
      audioFormat: "wav",
      sampleRateHz: 22050,
    });

    expect(result.requestId).toBe("abc-123");
  });
});
