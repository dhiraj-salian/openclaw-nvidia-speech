import { describe, it, expect } from "vitest";
import { RetryHttpClient } from "./retry-http-client.js";
import { FakeHttpClient } from "./fake-http-client.js";
import { NvSpeechError } from "./errors.js";

describe("RetryHttpClient", () => {
  it("returns first response when inner succeeds", async () => {
    const fake = new FakeHttpClient();
    fake.queueResponse({ status: 200, body: { ok: true } });
    const client = new RetryHttpClient(fake, { sleep: async () => {} });

    const res = await client.send({
      url: "https://x",
      method: "GET",
      headers: {},
      responseKind: "json",
    });

    expect(res.status).toBe(200);
    expect(fake.calls).toHaveLength(1);
  });

  it("retries on 429 (rate_limit) up to maxAttempts", async () => {
    const fake = new FakeHttpClient();
    fake.queueResponse(new NvSpeechError("rate limited", { kind: "rate_limit", status: 429 }));
    fake.queueResponse(new NvSpeechError("rate limited", { kind: "rate_limit", status: 429 }));
    fake.queueResponse({ status: 200, body: { ok: true } });

    const sleeps: number[] = [];
    const client = new RetryHttpClient(fake, {
      maxAttempts: 3,
      initialDelayMs: 10,
      jitterMs: 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const res = await client.send({
      url: "https://x",
      method: "GET",
      headers: {},
      responseKind: "json",
    });

    expect(res.status).toBe(200);
    expect(fake.calls).toHaveLength(3);
    // Backoff should be exponential: 10, 20.
    expect(sleeps).toEqual([10, 20]);
  });

  it("retries on 503 (server)", async () => {
    const fake = new FakeHttpClient();
    fake.queueResponse(new NvSpeechError("down", { kind: "server", status: 503 }));
    fake.queueResponse({ status: 200, body: {} });

    const client = new RetryHttpClient(fake, {
      maxAttempts: 2,
      initialDelayMs: 1,
      jitterMs: 0,
      sleep: async () => {},
    });

    await client.send({
      url: "https://x",
      method: "GET",
      headers: {},
      responseKind: "json",
    });

    expect(fake.calls).toHaveLength(2);
  });

  it("does NOT retry on 401 (auth)", async () => {
    const fake = new FakeHttpClient();
    fake.queueResponse(new NvSpeechError("no auth", { kind: "auth", status: 401 }));

    const client = new RetryHttpClient(fake, { sleep: async () => {} });

    await expect(
      client.send({
        url: "https://x",
        method: "GET",
        headers: {},
        responseKind: "json",
      }),
    ).rejects.toMatchObject({ kind: "auth" });

    expect(fake.calls).toHaveLength(1);
  });

  it("does NOT retry on 400 (bad_request)", async () => {
    const fake = new FakeHttpClient();
    fake.queueResponse(new NvSpeechError("bad", { kind: "bad_request", status: 400 }));

    const client = new RetryHttpClient(fake, { sleep: async () => {} });

    await expect(
      client.send({
        url: "https://x",
        method: "GET",
        headers: {},
        responseKind: "json",
      }),
    ).rejects.toMatchObject({ kind: "bad_request" });

    expect(fake.calls).toHaveLength(1);
  });

  it("throws after exhausting maxAttempts on persistent retryable error", async () => {
    const fake = new FakeHttpClient();
    fake.queueResponse(new NvSpeechError("x", { kind: "rate_limit", status: 429 }));
    fake.queueResponse(new NvSpeechError("x", { kind: "rate_limit", status: 429 }));
    fake.queueResponse(new NvSpeechError("x", { kind: "rate_limit", status: 429 }));

    const client = new RetryHttpClient(fake, {
      maxAttempts: 3,
      initialDelayMs: 1,
      jitterMs: 0,
      sleep: async () => {},
    });

    await expect(
      client.send({
        url: "https://x",
        method: "GET",
        headers: {},
        responseKind: "json",
      }),
    ).rejects.toMatchObject({ kind: "rate_limit" });

    expect(fake.calls).toHaveLength(3);
  });

  it("caps delay at maxDelayMs", async () => {
    const fake = new FakeHttpClient();
    fake.queueResponse(new NvSpeechError("x", { kind: "server", status: 500 }));
    fake.queueResponse(new NvSpeechError("x", { kind: "server", status: 500 }));
    fake.queueResponse({ status: 200, body: {} });

    const sleeps: number[] = [];
    const client = new RetryHttpClient(fake, {
      maxAttempts: 3,
      initialDelayMs: 100,
      maxDelayMs: 150,
      backoffMultiplier: 10,
      jitterMs: 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await client.send({
      url: "https://x",
      method: "GET",
      headers: {},
      responseKind: "json",
    });

    // 100, 150 (capped). Without cap would be 100, 1000.
    expect(sleeps).toEqual([100, 150]);
  });

  it("respects custom shouldRetry predicate (false → stop)", async () => {
    const fake = new FakeHttpClient();
    fake.queueResponse(new NvSpeechError("x", { kind: "rate_limit", status: 429 }));

    const client = new RetryHttpClient(fake, {
      maxAttempts: 5,
      sleep: async () => {},
      shouldRetry: () => false,
    });

    await expect(
      client.send({
        url: "https://x",
        method: "GET",
        headers: {},
        responseKind: "json",
      }),
    ).rejects.toMatchObject({ kind: "rate_limit" });

    expect(fake.calls).toHaveLength(1);
  });
});
