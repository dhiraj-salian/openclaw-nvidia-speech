import { describe, it, expect } from "vitest";
import { FakeHttpClient } from "../http/fake-http-client.js";
import { NvidiaSttClient } from "./nvidia-stt-client.js";
import { NvSpeechError } from "../http/errors.js";

const BASE = "https://integrate.api.nvidia.com/v1";
const MODEL = "parakeet-ctc-1.1b-en-multilingual";

/** Tiny fake audio buffer (16 bytes of zeros — content doesn't matter for HTTP-shape tests). */
function fakeAudio(): Buffer {
  return Buffer.from(new Uint8Array(16));
}

describe("NvidiaSttClient.transcribe", () => {
  it("POSTs to {baseUrl}/audio/transcriptions as multipart/form-data with bearer auth", async () => {
    const fake = new FakeHttpClient();
    fake.queueResponse({ status: 200, body: { text: "hello world" } });
    const client = new NvidiaSttClient(fake);

    const result = await client.transcribe({
      apiKey: "nvapi-test",
      baseUrl: BASE,
      model: MODEL,
      audio: fakeAudio(),
      fileName: "voice.ogg",
      mime: "audio/ogg",
    });

    expect(result.text).toBe("hello world");
    expect(result.model).toBe(MODEL);

    const sent = fake.calls[0]!;
    expect(sent.url).toBe(`${BASE}/audio/transcriptions`);
    expect(sent.method).toBe("POST");
    expect(sent.headers["Authorization"]).toBe("Bearer nvapi-test");
    expect(sent.headers["Accept"]).toBe("application/json");
    // Content-Type must NOT be set manually; fetch adds the multipart boundary.
    expect(sent.headers["Content-Type"]).toBeUndefined();

    expect(sent.body?.kind).toBe("formData");
    if (sent.body?.kind !== "formData") throw new Error("body kind");
    const form = sent.body.value as FormData;
    expect(form.get("model")).toBe(MODEL);
    expect(form.get("response_format")).toBe("json");

    const file = form.get("file");
    expect(file).toBeInstanceOf(Blob);
    const blob = file as Blob;
    expect(blob.type).toBe("audio/ogg");
    expect(blob.size).toBe(16);
    // `name` is set via the third arg of `FormData.append(file, name)`.
    // Different runtimes expose it differently; we accept either.
    const maybeName = (file as unknown as { name?: unknown }).name;
    if (typeof maybeName === "string") {
      expect(maybeName).toBe("voice.ogg");
    }
  });

  it("includes language and prompt fields when provided", async () => {
    const fake = new FakeHttpClient();
    fake.queueResponse({ status: 200, body: { text: "ok" } });
    const client = new NvidiaSttClient(fake);

    await client.transcribe({
      apiKey: "k",
      baseUrl: BASE,
      model: MODEL,
      audio: fakeAudio(),
      fileName: "a.wav",
      mime: "audio/wav",
      language: "en",
      prompt: "transcribe punctuation",
    });

    const form = fake.calls[0]!.body;
    if (form?.kind !== "formData") throw new Error("form kind");
    const fd = form.value as FormData;
    expect(fd.get("language")).toBe("en");
    expect(fd.get("prompt")).toBe("transcribe punctuation");
  });

  it("omits language and prompt fields when not provided", async () => {
    const fake = new FakeHttpClient();
    fake.queueResponse({ status: 200, body: { text: "ok" } });
    const client = new NvidiaSttClient(fake);

    await client.transcribe({
      apiKey: "k",
      baseUrl: BASE,
      model: MODEL,
      audio: fakeAudio(),
      fileName: "a.wav",
      mime: "audio/wav",
    });

    const form = fake.calls[0]!.body;
    if (form?.kind !== "formData") throw new Error("form kind");
    const fd = form.value as FormData;
    expect(fd.has("language")).toBe(false);
    expect(fd.has("prompt")).toBe(false);
  });

  it("returns model from response when server provides one (echo of actually-used model)", async () => {
    const fake = new FakeHttpClient();
    fake.queueResponse({ status: 200, body: { text: "hi", model: "fallback-model" } });
    const client = new NvidiaSttClient(fake);

    const result = await client.transcribe({
      apiKey: "k",
      baseUrl: BASE,
      model: MODEL,
      audio: fakeAudio(),
      fileName: "a.wav",
      mime: "audio/wav",
    });

    expect(result.model).toBe("fallback-model");
  });

  it("passes timeoutMs through to the HTTP layer", async () => {
    const fake = new FakeHttpClient();
    fake.queueResponse({ status: 200, body: { text: "ok" } });
    const client = new NvidiaSttClient(fake);

    await client.transcribe({
      apiKey: "k",
      baseUrl: BASE,
      model: MODEL,
      audio: fakeAudio(),
      fileName: "a.wav",
      mime: "audio/wav",
      timeoutMs: 5000,
    });

    expect(fake.calls[0]?.timeoutMs).toBe(5000);
  });

  it("rejects empty audio before HTTP", async () => {
    const fake = new FakeHttpClient();
    const client = new NvidiaSttClient(fake);

    await expect(
      client.transcribe({
        apiKey: "k",
        baseUrl: BASE,
        model: MODEL,
        audio: Buffer.alloc(0),
        fileName: "empty.wav",
        mime: "audio/wav",
      }),
    ).rejects.toThrow(/audio is required/);

    expect(fake.calls).toHaveLength(0);
  });

  it("rejects missing apiKey", async () => {
    const fake = new FakeHttpClient();
    const client = new NvidiaSttClient(fake);

    await expect(
      client.transcribe({
        apiKey: "",
        baseUrl: BASE,
        model: MODEL,
        audio: fakeAudio(),
        fileName: "a.wav",
        mime: "audio/wav",
      }),
    ).rejects.toThrow(/apiKey is required/);
  });

  it("rejects missing model", async () => {
    const fake = new FakeHttpClient();
    const client = new NvidiaSttClient(fake);

    await expect(
      client.transcribe({
        apiKey: "k",
        baseUrl: BASE,
        model: "   ",
        audio: fakeAudio(),
        fileName: "a.wav",
        mime: "audio/wav",
      }),
    ).rejects.toThrow(/model is required/);
  });

  it("rejects missing fileName", async () => {
    const fake = new FakeHttpClient();
    const client = new NvidiaSttClient(fake);

    await expect(
      client.transcribe({
        apiKey: "k",
        baseUrl: BASE,
        model: MODEL,
        audio: fakeAudio(),
        fileName: "",
        mime: "audio/wav",
      }),
    ).rejects.toThrow(/fileName is required/);
  });

  it("surfaces NvSpeechError on 401", async () => {
    const fake = new FakeHttpClient();
    fake.queueResponse(new NvSpeechError("nope", { kind: "auth", status: 401 }));
    const client = new NvidiaSttClient(fake);

    await expect(
      client.transcribe({
        apiKey: "bad",
        baseUrl: BASE,
        model: MODEL,
        audio: fakeAudio(),
        fileName: "a.wav",
        mime: "audio/wav",
      }),
    ).rejects.toMatchObject({ kind: "auth" });
  });

  it("captures requestId from response headers", async () => {
    const fake = new FakeHttpClient();
    fake.queueResponse({
      status: 200,
      headers: { "x-request-id": "req-abc-123" },
      body: { text: "hi" },
    });
    const client = new NvidiaSttClient(fake);

    const result = await client.transcribe({
      apiKey: "k",
      baseUrl: BASE,
      model: MODEL,
      audio: fakeAudio(),
      fileName: "a.wav",
      mime: "audio/wav",
    });

    expect(result.requestId).toBe("req-abc-123");
  });

  it("accepts raw string response body (defensive)", async () => {
    const fake = new FakeHttpClient();
    fake.queueResponse({ status: 200, body: "plain text transcript" });
    const client = new NvidiaSttClient(fake);

    const result = await client.transcribe({
      apiKey: "k",
      baseUrl: BASE,
      model: MODEL,
      audio: fakeAudio(),
      fileName: "a.wav",
      mime: "audio/wav",
    });

    expect(result.text).toBe("plain text transcript");
  });

  it("throws on missing `text` field in JSON response", async () => {
    const fake = new FakeHttpClient();
    fake.queueResponse({ status: 200, body: { foo: "bar" } });
    const client = new NvidiaSttClient(fake);

    await expect(
      client.transcribe({
        apiKey: "k",
        baseUrl: BASE,
        model: MODEL,
        audio: fakeAudio(),
        fileName: "a.wav",
        mime: "audio/wav",
      }),
    ).rejects.toThrow(/missing `text` field/);
  });

  it("accepts Uint8Array (not just Buffer)", async () => {
    const fake = new FakeHttpClient();
    fake.queueResponse({ status: 200, body: { text: "ok" } });
    const client = new NvidiaSttClient(fake);

    await client.transcribe({
      apiKey: "k",
      baseUrl: BASE,
      model: MODEL,
      audio: new Uint8Array([0xff, 0xfb, 0x90, 0x00]),
      fileName: "a.mp3",
      mime: "audio/mpeg",
    });

    const form = fake.calls[0]!.body;
    if (form?.kind !== "formData") throw new Error("form kind");
    const blob = (form.value as FormData).get("file") as Blob;
    expect(blob.type).toBe("audio/mpeg");
    expect(blob.size).toBe(4);
  });

  it("defaults the file Blob MIME to application/octet-stream when caller passes empty", async () => {
    const fake = new FakeHttpClient();
    fake.queueResponse({ status: 200, body: { text: "ok" } });
    const client = new NvidiaSttClient(fake);

    await client.transcribe({
      apiKey: "k",
      baseUrl: BASE,
      model: MODEL,
      audio: fakeAudio(),
      fileName: "blob",
      mime: "",
    });

    const form = fake.calls[0]!.body;
    if (form?.kind !== "formData") throw new Error("form kind");
    const blob = (form.value as FormData).get("file") as Blob;
    expect(blob.type).toBe("application/octet-stream");
  });
});
