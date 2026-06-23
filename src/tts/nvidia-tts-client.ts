/**
 * NvidiaTtsClient — raw TTS HTTP client (Magpie Multilingual).
 *
 * Endpoint: POST {baseUrl}/audio/synthesize
 *   - baseUrl is an NVCF function URL, e.g.
 *     `https://877104f7-e885-42b9-8de8-f6e4c6303969.invocation.api.nvcf.nvidia.com/v1`
 * Auth:     Authorization: Bearer {apiKey}
 * Body:     multipart/form-data with fields (from `/openapi.json` schema):
 *   - text              (required) the text to synthesize
 *   - language          (required) BCP-47 like `en-US`
 *   - voice             (optional) Magpie voice id, e.g.
 *                        `Magpie-Multilingual.EN-US.Aria`. Default = server choice.
 *   - sample_rate_hz    (optional) integer Hz (22050, 24000, …). Default = 22050.
 *   - encoding          (optional) e.g. `LINEAR_PCM`. Default = `LINEAR_PCM`.
 *   - custom_dictionary (optional) pronunciation hints.
 *   - audio_prompt      (optional) voice-cloning audio reference.
 *   - audio_prompt_transcript (optional) transcript for the prompt.
 *   - prompt_quality    (optional) quality hint for the prompt.
 * Response: audio bytes (Content-Type e.g. audio/wav, audio/mpeg).
 *
 * Pure I/O. No config defaults. No logging of API key.
 *
 * Implementation notes:
 *   - Uses the built-in `FormData` (Node 18+) so no `form-data` package needed.
 *   - The `FormData` body travels through the existing HttpClient abstraction
 *     (`body: { kind: "formData", value }`), so a `FakeHttpClient` can assert
 *     that the right fields are present.
 *   - Field names verified against the live `/openapi.json` of the Magpie
 *     NVCF function on 2026-06-23.
 *   - Earlier drafts sent `sample_rate` / `format` / `stream` / `model` —
 *     none of those keys exist in the spec. The endpoint silently ignored
 *     them and used its defaults, which is why earlier smoke tests
 *     "worked" but with the wrong schema.
 */

import type { HttpClient } from "../http/http-client.js";
import type { NvidiaTtsAudioFormat, NvidiaTtsSampleRate } from "../config/defaults.js";

export interface NvidiaTtsRequest {
  readonly apiKey: string;
  readonly baseUrl: string;
  /** Model id (e.g. `magpie-tts-multilingual`). */
  readonly model: string;
  /** Text to synthesize. */
  readonly text: string;
  /** Magpie voice id (e.g. `Magpie-Multilingual.EN-US.Aria`). */
  readonly voiceName: string;
  /** BCP-47 language tag (e.g. `en-US`). */
  readonly languageCode: string;
  /** Output audio format. */
  readonly audioFormat: NvidiaTtsAudioFormat;
  /** Sample rate in Hz. */
  readonly sampleRateHz: NvidiaTtsSampleRate;
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs?: number;
}

export interface NvidiaTtsResult {
  readonly audio: Uint8Array;
  readonly contentType: string;
  readonly fileExtension: string;
  readonly requestId?: string;
}

export class NvidiaTtsClient {
  constructor(private readonly http: HttpClient) {}

  async synthesize(req: NvidiaTtsRequest): Promise<NvidiaTtsResult> {
    if (!req.apiKey) throw new Error("apiKey is required");
    if (!req.text || req.text.trim().length === 0) {
      throw new Error("text is required");
    }
    if (!req.baseUrl) throw new Error("baseUrl is required");

    const url = `${stripTrailingSlash(req.baseUrl)}/audio/synthesize`;

    // Built-in FormData. We never set Content-Type — fetch (and our HttpClient)
    // generate the multipart boundary header automatically when body is FormData.
    //
    // Field names come straight from the Magpie function's `/openapi.json`
    // schema (see file header). Notably:
    //   - `sample_rate_hz`, NOT `sample_rate`.
    //   - No `format` field — output container is implied by the response
    //     Content-Type / `Accept` header we send.
    //   - No `stream` field — server defaults to non-streaming.
    //   - No `model` field — the function URL encodes the model.
    const form = new FormData();
    form.append("text", req.text);
    form.append("language", req.languageCode);
    if (req.voiceName && req.voiceName.trim().length > 0) {
      form.append("voice", req.voiceName);
    }
    form.append("sample_rate_hz", String(req.sampleRateHz));
    // `encoding` defaults to LINEAR_PCM server-side; only override when caller
    // passed one. (Currently the NvidiaTtsRequest type doesn't expose this,
    // but we keep the hook in place for callers that want MP3/FLAC/OPUS.)

    const res = await this.http.send<Uint8Array>({
      url,
      method: "POST",
      headers: {
        Authorization: `Bearer ${req.apiKey}`,
        Accept: `${req.audioFormat === "mp3" ? "audio/mpeg" : `audio/${req.audioFormat}`}`,
      },
      body: { kind: "formData", value: form },
      responseKind: "bytes",
      ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
    });

    const contentType = res.headers["content-type"] ?? `audio/${req.audioFormat}`;
    return {
      audio: res.body,
      contentType,
      fileExtension: fileExtensionForContentType(contentType, req.audioFormat),
      ...(res.requestId !== undefined ? { requestId: res.requestId } : {}),
    };
  }
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

export function fileExtensionForContentType(
  contentType: string,
  fallback: NvidiaTtsAudioFormat,
): string {
  const ct = contentType.toLowerCase();
  if (ct.includes("mpeg") || ct.includes("mp3")) return "mp3";
  if (ct.includes("flac")) return "flac";
  if (ct.includes("ogg")) return "ogg";
  if (ct.includes("opus")) return "opus";
  if (ct.includes("wav") || ct.includes("x-wav") || ct.includes("wave")) return "wav";
  // Fallback to whatever we asked for.
  return fallback;
}
