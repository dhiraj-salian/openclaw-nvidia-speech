/**
 * Voices listing + caching for NVIDIA TTS.
 *
 * The /v1/audio/list_voices endpoint is GET and returns a JSON object whose
 * shape is:
 *
 *   {
 *     "<comma-separated-language-codes>": {
 *       "voices": ["Magpie-Multilingual.EN-US.Aria", "Magpie-Multilingual.EN-US.Jason", ...]
 *     }
 *   }
 *
 * i.e. the top-level key is a CSV of supported languages (varies by which
 * model the function loads) and the value carries the voice-id list.
 * Verified live on 2026-06-23 against the Magpie NVCF function: it returned
 * 478 voices under the single key "en-US,es-US,fr-FR,de-DE,zh-CN,vi-VN,it-IT,hi-IN,ja-JP".
 *
 * We tolerate two extra shapes for forward/backward compatibility:
 *   - `{ voices: [...] }`              — flat array of strings or objects
 *   - `{ data: [...] }`                — OpenAI-compatible alt
 *
 * Cached in-memory for 1 hour so we don't hit NVIDIA every synthesize call.
 */

import type { HttpClient } from "../http/http-client.js";

export interface NvidiaVoice {
  readonly id: string;
  readonly name?: string;
  readonly language?: string;
  readonly gender?: "male" | "female" | "neutral" | string;
  readonly description?: string;
}

interface VoicesResponseEntry {
  voice_name?: string;
  voice_id?: string;
  name?: string;
  language?: string;
  language_code?: string;
  gender?: string;
  description?: string;
}

type VoicesResponse =
  | { voices?: unknown; data?: unknown }
  | Record<string, { voices?: unknown[] } | unknown[]>
  | unknown[];

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface CacheEntry {
  voices: NvidiaVoice[];
  fetchedAt: number;
}

export class VoicesClient {
  private cache = new Map<string, CacheEntry>();

  constructor(private readonly http: HttpClient) {}

  async listVoices(opts: {
    apiKey: string;
    baseUrl: string;
    forceRefresh?: boolean;
  }): Promise<NvidiaVoice[]> {
    const cacheKey = opts.baseUrl;
    if (!opts.forceRefresh) {
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return cached.voices;
      }
    }

    const url = `${stripTrailingSlash(opts.baseUrl)}/audio/list_voices`;
    const res = await this.http.send<VoicesResponse>({
      url,
      method: "GET",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        Accept: "application/json",
      },
      responseKind: "json",
    });

    const raw = extractVoiceEntries(res.body);
    const voices = raw
      .map((entry): NvidiaVoice | null => {
        // The live Magpie NVCF shape uses bare strings: ["…Aria", "…Jason"].
        // Earlier docs/example shapes used objects: { voice_id, language_code, … }.
        // Handle both.
        if (typeof entry === "string") {
          if (entry.length === 0) return null;
          return { id: entry };
        }
        const id = entry.voice_id ?? entry.voice_name ?? entry.name;
        if (typeof id !== "string" || id.length === 0) return null;
        const name = entry.name ?? entry.voice_name;
        const language = entry.language_code ?? entry.language;
        const gender = entry.gender;
        const description = entry.description;
        return {
          id,
          ...(typeof name === "string" ? { name } : {}),
          ...(typeof language === "string" ? { language } : {}),
          ...(typeof gender === "string" ? { gender } : {}),
          ...(typeof description === "string" ? { description } : {}),
        };
      })
      .filter((v): v is NvidiaVoice => v !== null);

    this.cache.set(cacheKey, { voices, fetchedAt: Date.now() });
    return voices;
  }

  /** Test helper — clear the cache. */
  clearCache(): void {
    this.cache.clear();
  }
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * Flatten the various response shapes `list_voices` may return into a single
 * flat array of entries (each entry is either a string voice-id or a richer
 * object). See file header for shape details.
 */
function extractVoiceEntries(body: unknown): Array<string | VoicesResponseEntry> {
  if (body === null || body === undefined) return [];
  if (Array.isArray(body)) return body as Array<string | VoicesResponseEntry>;

  if (typeof body === "object") {
    const obj = body as Record<string, unknown>;

    // Flat shape: { voices: [...] } or { data: [...] }
    if (Array.isArray(obj.voices)) {
      return obj.voices as Array<string | VoicesResponseEntry>;
    }
    if (Array.isArray(obj.data)) {
      return obj.data as Array<string | VoicesResponseEntry>;
    }

    // Nested shape (the live one): { "<langCSV>": { voices: [...] } }
    // Each top-level key is a CSV of languages; each value carries the
    // voice list. We flatten across all keys.
    const flattened: Array<string | VoicesResponseEntry> = [];
    for (const [key, value] of Object.entries(obj)) {
      // Defensive: skip the flat keys we already checked above.
      if (key === "voices" || key === "data") continue;
      if (Array.isArray(value)) {
        flattened.push(...(value as Array<string | VoicesResponseEntry>));
        continue;
      }
      if (value && typeof value === "object") {
        const inner = value as Record<string, unknown>;
        if (Array.isArray(inner.voices)) {
          flattened.push(...(inner.voices as Array<string | VoicesResponseEntry>));
        }
      }
    }
    return flattened;
  }

  return [];
}
