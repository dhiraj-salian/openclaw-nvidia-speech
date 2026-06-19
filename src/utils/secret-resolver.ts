/**
 * Resolve the NVIDIA API key from a clear priority chain.
 *
 * Priority (when `profileReader` is supplied):
 *   1. Explicit `apiKey` in provider config (may be a SecretRef-like object
 *      resolved by OpenClaw, or a plain string for unit tests / scripts).
 *   2. The named environment variable (default: NVIDIA_API_KEY).
 *   3. Profile fallback — scan `$HOME/.bashrc`, `$HOME/.zshrc`,
 *      `$HOME/.zprofile`, `$HOME/.profile` for an `NVIDIA_API_KEY=...`
 *      export. Mirrors the bundled `elevenlabs` plugin's
 *      `resolveElevenLabsApiKeyWithProfileFallback` pattern so users who
 *      already keep their key in their shell profile don't have to
 *      duplicate it in `openclaw.json` or `process.env`.
 *   4. Throw `MissingApiKeyError` — never fall back to empty string or
 *      `undefined`.
 *
 * Backward-compatible: callers that don't pass `profileReader` keep the
 * legacy `provided → env → throw` chain.
 *
 * CRITICAL: this module NEVER logs the resolved value, even at debug level.
 * Profile reads silently skip files that don't exist or can't be read.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ResolveApiKeyOptions {
  /** Config-time apiKey field; if present, takes priority over env + profile. */
  readonly provided?: unknown;
  /** Env var name to read from process.env (default: NVIDIA_API_KEY). */
  readonly envVar?: string;
  /** Optional override for env (e.g. test fixture). */
  readonly env?: Record<string, string | undefined>;
  /**
   * Optional profile-fallback reader. When supplied AND `provided`/env are
   * empty, the resolver scans shell profile files as a last resort.
   * Defaults to a no-op reader (legacy behaviour). Tests inject a fake.
   */
  readonly profileReader?: ProfileReader;
}

/**
 * Minimal slice of `node:fs` we touch. Lets tests inject a fake without
 * mocking the whole module.
 */
export interface ProfileReaderFs {
  readonly existsSync: (path: string) => boolean;
  readonly readFileSync: (path: string, encoding: "utf-8") => string;
}

/**
 * Minimal slice of `node:os` we touch. Tests inject a fake homedir.
 */
export interface ProfileReaderOs {
  readonly homedir: () => string;
}

/**
 * A ProfileReader scans the user's shell profile files for an
 * `<ENV_VAR>=<value>` export and returns the value, or null if absent.
 *
 * The default reader reads `.bashrc`, `.zshrc`, `.zprofile`, `.profile`
 * under `$HOME` in that order. Custom readers (e.g. for PowerShell on
 * Windows, or a CI secret store) can be supplied via `ResolveApiKeyOptions`.
 */
export interface ProfileReader {
  readonly os?: ProfileReaderOs;
  readonly fs?: ProfileReaderFs;
  /** Override env var name (defaults to whatever the resolver passes). */
  readonly envVar?: string;
}

export class MissingApiKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingApiKeyError";
  }
}

/** Coerce whatever OpenClaw passes as `apiKey` into a clean string. */
function coerceProvided(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (value && typeof value === "object" && "value" in value) {
    const inner = (value as { value: unknown }).value;
    if (typeof inner === "string" && inner.trim().length > 0) return inner.trim();
  }
  return undefined;
}

/**
 * Shell profile file candidates scanned for `NVIDIA_API_KEY=...`.
 * Matches the bundled elevenlabs plugin's PROFILE_CANDIDATES order so
 * OpenClaw users get a consistent scan behaviour across providers:
 *   - .profile first (the POSIX-standard login shell file)
 *   - .zprofile (zsh login file, supersedes .zshrc on macOS)
 *   - .zshrc (interactive zsh)
 *   - .bashrc (interactive bash)
 */
export const PROFILE_CANDIDATES: readonly string[] = [
  ".profile",
  ".zprofile",
  ".zshrc",
  ".bashrc",
] as const;

/**
 * Default no-op profile reader: returns null (skips the profile-fallback
 * step entirely). Production callers wire `buildDefaultProfileReader()`
 * via the plugin entry's `register()`.
 */
const NULL_PROFILE_READER: ProfileReader = Object.freeze({});

/**
 * Build the default profile reader using real `node:fs` + `node:os`.
 * Lazily evaluated — tests inject their own to keep fs hermetic.
 */
export function buildDefaultProfileReader(): ProfileReader {
  return {
    os: { homedir },
    fs: { existsSync, readFileSync },
  };
}

/**
 * Scan the user's shell profile files for a line of the form
 * `<ENV_VAR>=<value>` (optionally with a leading `export `) and return the
 * trimmed value, or null if no profile file contains it.
 *
 * Behaviour:
 *   - If no `ProfileReader` deps are provided, returns null (caller must
 *     default this in legacy mode).
 *   - Files that don't exist are silently skipped.
 *   - Files that exist but throw on read (EACCES, etc.) are silently
 *     skipped — the resolver will surface a clean MissingApiKeyError.
 *   - Match is regex-based and intentionally narrow: `^|\\n` followed by
 *     optional `export `, then the env var name, then `=`, then either
 *     a quoted or unquoted token. Matches both single and double quotes.
 */
export function readApiKeyFromProfile(
  reader: ProfileReader = NULL_PROFILE_READER,
): string | null {
  const osImpl = reader.os;
  const fsImpl = reader.fs;
  if (!osImpl || !fsImpl) return null;

  const envVar = reader.envVar ?? "NVIDIA_API_KEY";
  const home = osImpl.homedir();
  if (typeof home !== "string" || home.length === 0) return null;

  // Build the match regex once. Capture group 1 is the value.
  //   ^|\n            : start of file or after a newline
  //   \s*             : optional leading whitespace
  //   (?:export\s+)?  : optional "export " keyword
  //   VAR             : env var name, literal
  //   \s*=\s*         : `=` with optional whitespace
  //   (?:"([^"\n]*)"|'([^'\n]*)'|([^\s"'\n#]+)) : one of three value forms:
  //                     double-quoted, single-quoted, or bare token (stops
  //                     at whitespace, quote, newline, or shell comment).
  //   The captured group index depends on which branch matched; we extract
  //   it after the match via the helper below.
  const pattern = new RegExp(
    `(?:^|\\n)\\s*(?:export\\s+)?${envVar}\\s*=\\s*(?:"([^"\\n]*)"|'([^'\\n]*)'|([^\\s"'\\n#]+))`,
    "m",
  );

  for (const candidate of PROFILE_CANDIDATES) {
    const fullPath = join(home, candidate);
    let exists: boolean;
    try {
      exists = fsImpl.existsSync(fullPath);
    } catch {
      // existsSync shouldn't normally throw, but stay defensive.
      continue;
    }
    if (!exists) continue;

    let contents: string;
    try {
      contents = fsImpl.readFileSync(fullPath, "utf-8");
    } catch {
      // Permission denied, IO error, race with deletion — skip silently.
      continue;
    }

    const match = contents.match(pattern);
    if (match) {
      // Group 1 = double-quoted, Group 2 = single-quoted, Group 3 = bare.
      const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
      if (value.length > 0) return value;
    }
  }

  return null;
}

/**
 * Internal helpers exposed only for tests via the named export.
 */
export type { ProfileReaderDeps };
type ProfileReaderDeps = ProfileReader;

export function resolveApiKey(options: ResolveApiKeyOptions = {}): string {
  const envVar = options.envVar ?? "NVIDIA_API_KEY";
  const env = options.env ?? process.env;

  const provided = coerceProvided(options.provided);
  if (provided) return provided;

  const fromEnv = env[envVar];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }

  // Profile fallback — only consulted if `profileReader` is wired.
  // When omitted, fall straight through to the legacy throw.
  if (options.profileReader) {
    const reader: ProfileReader = {
      ...options.profileReader,
      envVar,
    };
    const fromProfile = readApiKeyFromProfile(reader);
    if (fromProfile) return fromProfile;
  }

  throw new MissingApiKeyError(
    `NVIDIA API key not found. Set the ${envVar} environment variable, ` +
      `add it to a shell profile (~/.bashrc, ~/.zshrc, ~/.zprofile, ~/.profile), ` +
      `or provide apiKey in plugin config.`,
  );
}

/**
 * Sanitize a config object for logging/diagnostics: removes the apiKey field
 * entirely. Always log through this, never the raw config.
 */
export function redactConfig<T extends Record<string, unknown>>(config: T): Omit<T, "apiKey"> {
  const { apiKey: _apiKey, ...rest } = config;
  void _apiKey;
  return rest;
}
