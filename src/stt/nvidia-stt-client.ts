/**
 * NvidiaSttClient — raw STT HTTP client (Parakeet CTC on NVCF).
 *
 * Endpoint: POST {baseUrl}/audio/transcriptions
 *   - baseUrl is an NVCF function URL, e.g.
 *     `https://1598d209-...nvcf.nvidia.com/v1`
 * Auth:     Authorization: Bearer {apiKey}
 * Body:     multipart/form-data with:
 *   - file             (required) audio Blob, e.g. `audio/wav`
 *   - language         (required) BCP-47 like `en-US`. The endpoint keys off
 *                      language to pick the model; this Parakeet function
 *                      only supports `en-US` (English-only model).
 *   - prompt           (optional) natural-language hint to bias decoding
 *   - response_format  (optional) `json` (default) | `text` | `srt` | `vtt`
 *   - temperature      (optional) float in [0, 1]
 *   - model            NOT sent — the NVCF function encodes its model in its
 *                      own URL. Sending `model=anything` is rejected with
 *                      HTTP 400 "bad model". Discovered during live smoke
 *                      on 2026-06-23.
 *
 * Response: JSON { text: "..." }
 *
 * Pure I/O. No config defaults. No logging of API key.
 *
 * Implementation notes:
 *   - Uses the built-in `FormData` and `Blob` (Node 18+). No `form-data` package
 *     — keeps the runtime deps count at zero.
 *   - The `FormData` body travels through the existing HttpClient abstraction
 *     (`body: { kind: "formData", value }`), so a `FakeHttpClient` can assert
 *     that the right fields are present.
 *   - The Mime type on the file Blob is set from the supplied MIME, defaulting
 *     to `application/octet-stream` when unknown. The endpoint is permissive
 *     about audio MIMEs but a correct hint helps logging on the server side.
 */

import type { HttpClient } from "../http/http-client.js";

export interface NvidiaSttRequest {
  readonly apiKey: string;
  readonly baseUrl: string;
  /**
   * Model id (e.g. `parakeet-ctc-1.1b-en-multilingual`). Currently unused
   * at the HTTP layer — the NVCF function URL already encodes its model.
   * Kept on the request struct so callers (and the media provider) can
   * preserve whatever they configured, and so we can route by model later
   * if NVIDIA exposes a multilingual Parakeet function ID.
   */
  readonly model?: string;
  /** Raw audio bytes. Caller owns the buffer; we never mutate it. */
  readonly audio: Buffer | Uint8Array;
  /** File name sent to the server (helps with content sniffing). */
  readonly fileName: string;
  /** MIME type, e.g. `audio/ogg`, `audio/mpeg`, `audio/wav`. */
  readonly mime: string;
  /**
   * BCP-47 language tag (e.g. `en-US`). REQUIRED for the NVCF Parakeet
   * endpoint — it picks its model by language. The current English-only
   * function only honours `en-US`; other values are rejected with
   * "Model not found for language <x>".
   */
  readonly language?: string;
  /** Optional natural-language prompt to bias the decoder. */
  readonly prompt?: string;
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs?: number;
}

export interface NvidiaSttResult {
  readonly text: string;
  readonly model: string;
  readonly requestId?: string;
  /** Raw response payload (for diagnostics). */
  readonly providerPayload?: unknown;
}

export class NvidiaSttClient {
  constructor(private readonly http: HttpClient) {}

  async transcribe(req: NvidiaSttRequest): Promise<NvidiaSttResult> {
    if (!req.apiKey) throw new Error("apiKey is required");
    if (!req.baseUrl) throw new Error("baseUrl is required");
    if (!req.audio || (req.audio as Uint8Array).byteLength === 0) {
      throw new Error("audio is required (non-empty buffer)");
    }
    if (!req.fileName || req.fileName.trim().length === 0) {
      throw new Error("fileName is required");
    }

    const url = `${stripTrailingSlash(req.baseUrl)}/audio/transcriptions`;

    // Language is REQUIRED on the NVCF Parakeet endpoint — it's how the
    // function picks its ASR model. Default to `en-US` (the only language
    // this function supports per /v1/manifest probe on 2026-06-23) so
    // callers that forget to set language still get a useful result.
    const language = (req.language && req.language.trim()) || "en-US";

    // Built-in FormData (Node 18+). Setting an explicit Blob lets fetch
    // generate a proper `filename` and `Content-Type: audio/<sub>` part.
    //
    // We copy into a fresh ArrayBuffer so the Blob's underlying buffer type
    // matches the strict DOM lib expectation (ArrayBuffer, not ArrayBufferLike).
    //
    // NOTE: We deliberately do NOT append `model`. The NVCF function URL
    // already encodes which model it serves; sending any `model=<x>` value
    // (even a "correct-looking" one) is rejected with HTTP 400 "bad model".
    const form = new FormData();
    const fresh = toFreshArrayBuffer(req.audio);
    const blob = new Blob([fresh], {
      type: req.mime || "application/octet-stream",
    });
    form.append("file", blob, req.fileName);
    form.append("language", language);
    form.append("response_format", "json");
    if (req.prompt && req.prompt.trim().length > 0) {
      form.append("prompt", req.prompt.trim());
    }

    const res = await this.http.send<unknown>({
      url,
      method: "POST",
      headers: {
        Authorization: `Bearer ${req.apiKey}`,
        // Note: do NOT set Content-Type — fetch will set the multipart
        // boundary automatically when body is a FormData instance.
        Accept: "application/json",
      },
      body: { kind: "formData", value: form },
      responseKind: "json",
      ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
    });

    const parsed = parseTranscribeResponse(res.body);
    return {
      text: parsed.text,
      model: parsed.model ?? req.model ?? "parakeet-ctc-1.1b-en-us",
      ...(res.requestId !== undefined ? { requestId: res.requestId } : {}),
      ...(res.body !== undefined ? { providerPayload: res.body } : {}),
    };
  }
}

/**
 * Tolerate several response shapes the NVIDIA / OpenAI-compatible endpoint
 * may return:
 *   - { text: "..." }
 *   - { text: "...", model: "..." }
 *   - { transcription: "..." }      (less common)
 *   - string (raw text)
 * Always returns at least `text`. If a `model` field is present, it's
 * preferred over the request model so the caller sees what was actually
 * used (NVIDIA sometimes auto-falls-back to a smaller model on quota).
 */
export function parseTranscribeResponse(payload: unknown): {
  text: string;
  model?: string;
} {
  if (typeof payload === "string") {
    return { text: payload };
  }
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    const text = pickString(obj, "text", "transcription", "result", "data");
    if (text === undefined) {
      throw new Error(
        "transcription response missing `text` field: " +
          JSON.stringify(safeSlice(obj)).slice(0, 300),
      );
    }
    const model = pickString(obj, "model");
    return model !== undefined ? { text, model } : { text };
  }
  throw new Error(
    "transcription response must be JSON object or string; got " + typeof payload,
  );
}

function pickString(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/** Drop non-serialisable / huge fields before stringifying for diagnostics. */
function safeSlice(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") out[k] = v.length > 200 ? v.slice(0, 200) + "…" : v;
    else if (v && typeof v === "object") out[k] = "[object]";
    else out[k] = v;
  }
  return out;
}

function toFreshArrayBuffer(buf: Buffer | Uint8Array): ArrayBuffer {
  // Always allocate a fresh, non-shared ArrayBuffer so the resulting Blob
  // satisfies the strict DOM type (which rejects SharedArrayBuffer).
  const out = new ArrayBuffer(buf.byteLength);
  new Uint8Array(out).set(buf);
  return out;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}
