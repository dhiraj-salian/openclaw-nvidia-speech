/**
 * NvidiaSttClient — raw STT HTTP client (Parakeet CTC, OpenAI-compatible).
 *
 * Endpoint: POST {baseUrl}/audio/transcriptions
 * Auth:     Authorization: Bearer {apiKey}
 * Body:     multipart/form-data with `file` (Blob), `model`, optional `language`, `response_format`
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
  /** Model id (e.g. `parakeet-ctc-1.1b-en-multilingual`). */
  readonly model: string;
  /** Raw audio bytes. Caller owns the buffer; we never mutate it. */
  readonly audio: Buffer | Uint8Array;
  /** File name sent to the server (helps with content sniffing). */
  readonly fileName: string;
  /** MIME type, e.g. `audio/ogg`, `audio/mpeg`, `audio/wav`. */
  readonly mime: string;
  /** Optional language hint (e.g. `en`). `auto` lets the server detect. */
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
    if (!req.model || req.model.trim().length === 0) throw new Error("model is required");
    if (!req.audio || (req.audio as Uint8Array).byteLength === 0) {
      throw new Error("audio is required (non-empty buffer)");
    }
    if (!req.fileName || req.fileName.trim().length === 0) {
      throw new Error("fileName is required");
    }

    const url = `${stripTrailingSlash(req.baseUrl)}/audio/transcriptions`;

    // Built-in FormData (Node 18+). Setting an explicit Blob lets fetch
    // generate a proper `filename` and `Content-Type: audio/<sub>` part.
    //
    // We copy into a fresh ArrayBuffer so the Blob's underlying buffer type
    // matches the strict DOM lib expectation (ArrayBuffer, not ArrayBufferLike).
    const form = new FormData();
    const fresh = toFreshArrayBuffer(req.audio);
    const blob = new Blob([fresh], {
      type: req.mime || "application/octet-stream",
    });
    form.append("file", blob, req.fileName);
    form.append("model", req.model);
    form.append("response_format", "json");
    if (req.language && req.language.trim().length > 0) {
      form.append("language", req.language.trim());
    }
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
      model: parsed.model ?? req.model,
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
