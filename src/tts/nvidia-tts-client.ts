/**
 * NvidiaTtsClient — raw TTS HTTP client (Magpie Multilingual).
 *
 * Endpoint: POST {baseUrl}/audio/synthesize
 * Auth:     Authorization: Bearer {apiKey}
 * Body:     JSON { model, text, voice_name, language_code, audio_format, sample_rate_hz, encoding }
 * Response: audio bytes (Content-Type e.g. audio/wav, audio/mpeg)
 *
 * Pure I/O. No config defaults. No logging of API key.
 */

import type { HttpClient } from "../http/http-client.js";
import type { NvidiaTtsAudioFormat, NvidiaTtsSampleRate } from "../config/defaults.js";

export interface NvidiaTtsRequest {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly text: string;
  readonly voiceName: string;
  readonly languageCode: string;
  readonly audioFormat: NvidiaTtsAudioFormat;
  readonly sampleRateHz: NvidiaTtsSampleRate;
  readonly encoding?: "LINEAR16" | "FLAC" | "MULAW" | "ALAW" | "OPUS" | "MP3";
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
    const encoding = req.encoding ?? defaultEncodingFor(req.audioFormat);

    const body = {
      model: req.model,
      text: req.text,
      voice_name: req.voiceName,
      language_code: req.languageCode,
      audio_format: req.audioFormat,
      sample_rate_hz: req.sampleRateHz,
      encoding,
    };

    const res = await this.http.send<Uint8Array>({
      url,
      method: "POST",
      headers: {
        Authorization: `Bearer ${req.apiKey}`,
        Accept: `${req.audioFormat === "mp3" ? "audio/mpeg" : `audio/${req.audioFormat}`}`,
      },
      body: { kind: "json", value: body },
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

function defaultEncodingFor(format: NvidiaTtsAudioFormat): "LINEAR16" | "MP3" | "FLAC" | "OPUS" {
  switch (format) {
    case "wav":
      return "LINEAR16";
    case "mp3":
      return "MP3";
    case "flac":
      return "FLAC";
    case "ogg":
    case "opus":
      return "OPUS";
  }
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
