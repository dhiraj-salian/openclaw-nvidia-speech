/**
 * Voices listing + caching for NVIDIA TTS.
 *
 * The /v1/audio/voices endpoint is GET and returns a JSON array of voices.
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

interface VoicesResponse {
  voices?: VoicesResponseEntry[];
  data?: VoicesResponseEntry[];
}

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

    const url = `${stripTrailingSlash(opts.baseUrl)}/audio/voices`;
    const res = await this.http.send<VoicesResponse>({
      url,
      method: "GET",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        Accept: "application/json",
      },
      responseKind: "json",
    });

    const raw = res.body?.voices ?? res.body?.data ?? [];
    const voices = raw
      .map((entry): NvidiaVoice | null => {
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
