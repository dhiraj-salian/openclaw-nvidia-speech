import { describe, it, expect } from "vitest";
import { FakeHttpClient } from "../http/fake-http-client.js";
import { VoicesClient } from "./voices.js";

describe("VoicesClient.listVoices", () => {
  const BASE = "https://integrate.api.nvidia.com/v1";

  it("GETs {baseUrl}/audio/list_voices with bearer auth and parses 'voices' array", async () => {
    const fake = new FakeHttpClient();
    fake.queueResponse({
      status: 200,
      body: {
        voices: [
          { voice_id: "Magpie-Multilingual.EN-US.Aria", language_code: "en-US", gender: "female", description: "Warm female" },
          { voice_id: "Magpie-Multilingual.EN-US.Brian", language_code: "en-US", gender: "male" },
          { voice_id: "Magpie-Multilingual.HI-IN.Aditi", language_code: "hi-IN", gender: "female" },
        ],
      },
    });

    const client = new VoicesClient(fake);
    const voices = await client.listVoices({ apiKey: "k", baseUrl: BASE });

    expect(voices).toHaveLength(3);
    expect(voices[0]).toMatchObject({
      id: "Magpie-Multilingual.EN-US.Aria",
      language: "en-US",
      gender: "female",
      description: "Warm female",
    });
    expect(voices[2]?.language).toBe("hi-IN");

    const call = fake.calls[0]!;
    expect(call.url).toBe(`${BASE}/audio/list_voices`);
    expect(call.method).toBe("GET");
    expect(call.headers["Authorization"]).toBe("Bearer k");
  });

  it("accepts 'data' field as alternative to 'voices'", async () => {
    const fake = new FakeHttpClient();
    fake.queueResponse({
      status: 200,
      body: { data: [{ voice_name: "v1" }, { voice_id: "v2" }] },
    });

    const client = new VoicesClient(fake);
    const voices = await client.listVoices({ apiKey: "k", baseUrl: BASE });

    expect(voices.map((v) => v.id)).toEqual(["v1", "v2"]);
  });

  it("caches results for 1 hour", async () => {
    const fake = new FakeHttpClient();
    fake.queueResponse({
      status: 200,
      body: { voices: [{ voice_id: "v1" }] },
    });

    const client = new VoicesClient(fake);
    const first = await client.listVoices({ apiKey: "k", baseUrl: BASE });
    const second = await client.listVoices({ apiKey: "k", baseUrl: BASE });

    expect(first).toBe(second); // same array reference
    expect(fake.calls).toHaveLength(1); // only one HTTP call
  });

  it("forceRefresh bypasses cache", async () => {
    const fake = new FakeHttpClient();
    fake.queueResponse({ status: 200, body: { voices: [{ voice_id: "v1" }] } });
    fake.queueResponse({ status: 200, body: { voices: [{ voice_id: "v2" }] } });

    const client = new VoicesClient(fake);
    await client.listVoices({ apiKey: "k", baseUrl: BASE });
    const second = await client.listVoices({
      apiKey: "k",
      baseUrl: BASE,
      forceRefresh: true,
    });

    expect(second[0]?.id).toBe("v2");
    expect(fake.calls).toHaveLength(2);
  });

  it("skips entries with no usable id", async () => {
    const fake = new FakeHttpClient();
    fake.queueResponse({
      status: 200,
      body: { voices: [{ voice_id: "ok" }, { /* no id */ }, { voice_name: "via-name" }] },
    });

    const client = new VoicesClient(fake);
    const voices = await client.listVoices({ apiKey: "k", baseUrl: BASE });

    expect(voices.map((v) => v.id)).toEqual(["ok", "via-name"]);
  });

  it("handles empty voices array", async () => {
    const fake = new FakeHttpClient();
    fake.queueResponse({ status: 200, body: { voices: [] } });

    const client = new VoicesClient(fake);
    const voices = await client.listVoices({ apiKey: "k", baseUrl: BASE });

    expect(voices).toEqual([]);
  });

  it("parses the nested Magpie NVCF shape: { '<langsCSV>': { voices: [...] } }", async () => {
    // The live Magpie function (verified 2026-06-23) returns:
    //   { "en-US,es-US,fr-FR,de-DE,zh-CN,vi-VN,it-IT,hi-IN,ja-JP": {
    //       voices: ["Magpie-Multilingual.EN-US.Aria", ...]
    //   }}
    // Voice entries are bare strings, not objects.
    const fake = new FakeHttpClient();
    fake.queueResponse({
      status: 200,
      body: {
        "en-US,es-US,fr-FR,de-DE,zh-CN,vi-VN,it-IT,hi-IN,ja-JP": {
          voices: [
            "Magpie-Multilingual.EN-US.Aria",
            "Magpie-Multilingual.EN-US.Jason",
            "Magpie-Multilingual.HI-IN.Aditi",
          ],
        },
      },
    });

    const client = new VoicesClient(fake);
    const voices = await client.listVoices({ apiKey: "k", baseUrl: BASE });

    expect(voices.map((v) => v.id)).toEqual([
      "Magpie-Multilingual.EN-US.Aria",
      "Magpie-Multilingual.EN-US.Jason",
      "Magpie-Multilingual.HI-IN.Aditi",
    ]);
    // Bare-string voices don't have a separate language/gender; that's fine.
    expect(voices[0]).toEqual({ id: "Magpie-Multilingual.EN-US.Aria" });
  });

  it("flattens voices across multiple nested language groups", async () => {
    // If the server ever returns multiple top-level keys (one per language
    // group), we should union them all. This is forward-compat.
    const fake = new FakeHttpClient();
    fake.queueResponse({
      status: 200,
      body: {
        "en-US": { voices: ["v-en-1", "v-en-2"] },
        "hi-IN": { voices: ["v-hi-1"] },
      },
    });

    const client = new VoicesClient(fake);
    const voices = await client.listVoices({ apiKey: "k", baseUrl: BASE });

    expect(voices.map((v) => v.id).sort()).toEqual(["v-en-1", "v-en-2", "v-hi-1"]);
  });
});
