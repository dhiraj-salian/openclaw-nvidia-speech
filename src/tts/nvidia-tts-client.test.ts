import { describe, it, expect } from "vitest";
import { FakeHttpClient } from "../http/fake-http-client.js";
import { NvidiaTtsClient } from "./nvidia-tts-client.js";
import { NvSpeechError } from "../http/errors.js";

/**
 * Returns the FormData instance from a fake call's body (asserted to be formData),
 * plus a helper that reads each field out of it.
 */
function getFormData(call: { body?: { kind: string; value: unknown } }): {
  text: string;
  language: string;
  voice: string;
  sample_rate_hz: string;
} {
  if (!call.body) throw new Error("test bug: call.body missing");
  expect(call.body.kind).toBe("formData");
  const form = call.body.value as FormData;
  // FormData entries are accessible via .get(). When the value is a string,
  // this is exactly what the multipart writer serialized. For Blob-backed
  // entries we'd need a different helper — but TTS only sends strings.
  const get = (k: string): string => String(form.get(k) ?? "");
  return {
    text: get("text"),
    language: get("language"),
    voice: get("voice"),
    sample_rate_hz: get("sample_rate_hz"),
  };
}

describe("NvidiaTtsClient.synthesize", () => {
  const BASE = "https://877104f7-e885-42b9-8de8-f6e4c6303969.invocation.api.nvcf.nvidia.com/v1";

  it("POSTs multipart to {baseUrl}/audio/synthesize with bearer auth and right fields", async () => {
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
    expect(sent.headers["Content-Type"]).toBeUndefined(); // fetch sets multipart boundary

    const fields = getFormData(sent);
    expect(fields.text).toBe("Hello world");
    expect(fields.language).toBe("en-US");
    expect(fields.voice).toBe("Magpie-Multilingual.EN-US.Aria");
    // Field names verified against Magpie /openapi.json on 2026-06-23:
    // it is `sample_rate_hz`, NOT `sample_rate`. We don't send `format`,
    // `stream`, or `model` (server picks defaults from the function URL).
    expect(fields.sample_rate_hz).toBe("22050");
    const form = sent.body?.value as FormData;
    expect(form.has("format")).toBe(false);
    expect(form.has("stream")).toBe(false);
    expect(form.has("model")).toBe(false);
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
