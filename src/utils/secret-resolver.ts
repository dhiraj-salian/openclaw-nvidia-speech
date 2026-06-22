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
import { createRequire } from "node:module";

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

// ---------------------------------------------------------------------------
// Auth-profile integration (OpenClaw runtime auth store)
//
// The runtime at `openclaw/plugin-sdk/provider-auth-runtime` exposes
// `resolveApiKeyForProvider({ provider, cfg, profileId, agentDir })` which
// walks the same auth profile store the bundled `nvidia` chat provider
// uses (`auth.profiles.nvidia:default` etc.). That means a single NVIDIA key
// configured once in OpenClaw's auth profile serves BOTH the chat
// provider and our TTS/STT plugin — no duplicate configuration.
//
// We import the SDK helper lazily so that callers without the runtime
// present (e.g. unit tests, build-time scripts) still work via the legacy
// chain below.
//
// IMPORTANT: a bare `await import("openclaw/plugin-sdk/provider-auth-runtime")`
// does NOT work from a plugin's dist/index.js — the plugin's own
// `node_modules` doesn't have `openclaw` as a dependency (esbuild keeps
// it external per scripts/build.mjs). Node's ESM loader searches relative
// to the importing file's URL, not the host process. The fix is to use
// `createRequire` anchored to a known file inside the OpenClaw
// installation so Node's CommonJS resolver finds the SDK relative to
// THAT directory. We try a few candidate anchors (env var, well-known
// global paths, process.argv path-walk) and cache the first that works.
// ---------------------------------------------------------------------------

/**
 * Anchor filenames we use to build a `createRequire` rooted inside an
 * OpenClaw installation. The actual probe logic lives in
 * `loadOpenClawSdk()` below; this constant is kept here as a
 * documentation marker for the env-var override path. (See the
 * OPENCLAW_PLUGIN_SDK_ANCHOR branch in `loadOpenClawSdk`.)
 */
const OPENCLAW_PLUGIN_SDK_ANCHOR_ENV = "OPENCLAW_PLUGIN_SDK_ANCHOR";

/**
 * Cached SDK require function. Null = never tried yet. Resolved = the
 * require fn anchored to the openclaw install's directory. Throws are
 * swallowed and recorded as `null` so subsequent calls short-circuit.
 */
let cachedSdkRequire: ((mod: string) => unknown) | null | undefined;

/**
 * Probe well-known install locations for the openclaw SDK and return a
 * require function rooted there. Returns null when nothing matches —
 * callers fall back to the legacy chain in that case.
 *
 * Strategies (in order):
 *   1. `OPENCLAW_PLUGIN_SDK_ANCHOR` env var (any file inside the
 *      openclaw install).
 *   2. Common global npm locations: `$npm_config_prefix/lib/node_modules/openclaw`
 *      resolved via `npm root -g`, plus `~/.npm-global/lib/node_modules/openclaw`
 *      and `/usr/local/lib/node_modules/openclaw` as last-ditch defaults.
 *   3. The `process.argv[1]` of the host (the gateway entry script) —
 *      its parent's parent's parent is typically the openclaw install.
 */
function loadOpenClawSdk(): ((mod: string) => unknown) | null {
  if (cachedSdkRequire !== undefined) return cachedSdkRequire;

  const t0 = Date.now();
  const anchors: string[] = [];
  if (process.env.NVIDIA_SPEECH_PLUGIN_DEBUG) {
    console.warn("[nvidia-speech] loadOpenClawSdk: starting...");
  }
  // Periodic heartbeat so we can see if it's blocked vs taking time.
  let heartbeat: NodeJS.Timeout | undefined;
  if (process.env.NVIDIA_SPEECH_PLUGIN_DEBUG) {
    heartbeat = setInterval(() => {
      const elapsed = Date.now() - t0;
      console.warn(`[nvidia-speech] loadOpenClawSdk heartbeat: ${elapsed}ms elapsed`);
    }, 200);
  }

  // Strategy 1: explicit env var.
  if (process.env[OPENCLAW_PLUGIN_SDK_ANCHOR_ENV]) {
    anchors.push(process.env[OPENCLAW_PLUGIN_SDK_ANCHOR_ENV] as string);
  }

  // Strategy 2: well-known global npm locations.
  const home = homedir();
  const wellKnownInstalls: readonly string[] = [
    join(home, ".npm-global", "lib", "node_modules", "openclaw"),
    "/usr/local/lib/node_modules/openclaw",
    "/usr/lib/node_modules/openclaw",
    join(home, ".nvm", "versions", "node", process.versions.node, "lib", "node_modules", "openclaw"),
  ];
  for (const installRoot of wellKnownInstalls) {
    const pkgJson = join(installRoot, "package.json");
    if (existsSync(pkgJson)) anchors.push(pkgJson);
  }

  // Strategy 3: process.argv[1] (the script that started this process).
  // For the gateway that's `<install>/dist/index.js`; `<install>` is two
  // levels up. For unit tests it's something else entirely — that's
  // fine, the file won't exist there and we move on.
  try {
    const argv1 = process.argv[1];
    if (typeof argv1 === "string" && argv1.length > 0) {
      // Resolve relative to cwd if needed.
      const resolved = argv1.startsWith("/") ? argv1 : join(process.cwd(), argv1);
      if (existsSync(resolved)) {
        const pkgJson = join(resolved, "..", "..", "package.json");
        if (existsSync(pkgJson)) anchors.push(pkgJson);
      }
    }
  } catch {
    /* ignore */
  }

  // Try each anchor — the first one whose require resolves the SDK wins.
  if (process.env.NVIDIA_SPEECH_PLUGIN_DEBUG) {
    console.warn(`[nvidia-speech] loadOpenClawSdk: probing ${anchors.length} anchor(s):`, anchors);
  }
  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i];
    if (!anchor) continue;
    try {
      const installRoot = anchor.replace(/\/package\.json$/, "");
      const internalAnchor = join(installRoot, "dist", "plugin-sdk", "index.js");
      if (process.env.NVIDIA_SPEECH_PLUGIN_DEBUG) {
        console.warn(`[nvidia-speech] anchor[${i}] checking ${internalAnchor}`);
      }
      if (!existsSync(internalAnchor)) {
        if (process.env.NVIDIA_SPEECH_PLUGIN_DEBUG) {
          console.warn(
            `[nvidia-speech] SDK anchor miss: ${internalAnchor} does not exist`,
          );
        }
        continue;
      }
      if (process.env.NVIDIA_SPEECH_PLUGIN_DEBUG) {
        console.warn(`[nvidia-speech] anchor[${i}] creating require...`);
      }
      const req = createRequire(internalAnchor);
      if (process.env.NVIDIA_SPEECH_PLUGIN_DEBUG) {
        console.warn(`[nvidia-speech] anchor[${i}] requiring ./provider-auth-runtime.js ...`);
      }
      const sdk = req("./provider-auth-runtime.js") as {
        resolveApiKeyForProvider?: unknown;
      };
      if (process.env.NVIDIA_SPEECH_PLUGIN_DEBUG) {
        console.warn(`[nvidia-speech] anchor[${i}] require returned; sdk resolveApiKeyForProvider type:`, typeof sdk?.resolveApiKeyForProvider);
      }
      if (sdk && typeof sdk.resolveApiKeyForProvider === "function") {
        if (process.env.NVIDIA_SPEECH_PLUGIN_DEBUG) {
          console.warn(`[nvidia-speech] anchor[${i}] ✓ resolved; caching`);
        }
        cachedSdkRequire = req;
        if (heartbeat) clearInterval(heartbeat);
        return cachedSdkRequire;
      }
    } catch (err) {
      if (process.env.NVIDIA_SPEECH_PLUGIN_DEBUG) {
        console.warn(
          `[nvidia-speech] SDK load failed for anchor ${anchor}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  if (process.env.NVIDIA_SPEECH_PLUGIN_DEBUG) {
    console.warn(
      `[nvidia-speech] No OpenClaw SDK anchor worked. Tried: ${anchors.length} paths.`,
    );
  }
  if (heartbeat) clearInterval(heartbeat);
  cachedSdkRequire = null;
  return null;
}

/**
 * Test/debug helper: forget the cached SDK require so the next call
 * re-probes. Useful when the install path changes (e.g. switching
 * profiles or rebuilding the openclaw install).
 */
export function __resetOpenClawSdkCacheForTests(): void {
  cachedSdkRequire = undefined;
}

/**
 * Minimal slice of the OpenClaw auth config we touch. Kept loose on
 * purpose: the SDK's full `OpenClawConfig` is wide and we don't want to
 * duplicate it here.
 */
export interface NvidiaAuthProfileConfig {
  readonly auth?: {
    readonly profiles?: Record<
      string,
      { readonly provider?: string; readonly mode?: string }
    >;
  };
}

/**
 * Shape returned by the runtime resolver. We only use `.apiKey`.
 */
export interface ResolvedNvidiaAuth {
  readonly apiKey?: string;
  readonly profileId?: string;
  readonly source?: string;
}

/**
 * Options for the async auth-profile-aware resolver.
 *
 * Resolution order (mirrors the bundled `nvidia` chat plugin):
 *   1. Explicit `provided` (e.g. from `providerConfig.apiKey`).
 *   2. Runtime auth profile store via `resolveApiKeyForProvider`
 *      (i.e. `openclaw config get auth.profiles['nvidia:default']` etc.).
 *   3. Legacy chain: `process.env[envVar]` → shell-profile fallback.
 *   4. Throw `MissingApiKeyError`.
 */
export interface ResolveNvidiaApiKeyOptions {
  /** Explicit apiKey override (providerConfig.apiKey from the request). */
  readonly provided?: unknown;
  /** Env var name; defaults to NVIDIA_API_KEY. */
  readonly envVar?: string;
  /** OpenClaw config — pass `api.config` from `register(api)`. */
  readonly cfg?: NvidiaAuthProfileConfig | undefined;
  /** Optional preferred profile id (overrides auto-detect). */
  readonly profileId?: string;
  /** Optional agent dir (multi-agent setups). */
  readonly agentDir?: string;
  /** Env override for tests. Defaults to `process.env`. */
  readonly env?: Record<string, string | undefined>;
  /** Optional profile-fallback reader (legacy). */
  readonly profileReader?: ProfileReader;
}

/**
 * Async resolver: NVIDIA API key, profile-aware.
 *
 * When `cfg` is provided, this delegates to the OpenClaw runtime's
 * `resolveApiKeyForProvider({ provider: "nvidia", cfg, profileId, agentDir })`
 * which walks `auth.profiles` and selects the matching profile
 * (`nvidia:default`, etc.). This is the **same code path** the bundled
 * `nvidia` chat provider uses, so a single configured key serves both.
 *
 * On resolution failure (no profile, missing key, SDK not loadable), we
 * fall back to the legacy `resolveApiKey` chain so unit tests and
 * build-time scripts keep working.
 *
 * CRITICAL: never log the resolved value, even at debug level.
 */
export async function resolveNvidiaApiKey(
  options: ResolveNvidiaApiKeyOptions = {},
): Promise<string> {
  const envVar = options.envVar ?? "NVIDIA_API_KEY";

  // 1) Explicit override (providerConfig.apiKey) wins over everything.
  const provided = coerceProvided(options.provided);
  if (provided) return provided;

  // 2) Runtime auth profile (only if cfg is supplied).
  if (options.cfg) {
    try {
      // The bare `await import("openclaw/plugin-sdk/...")` form fails
      // with ERR_MODULE_NOT_FOUND from a plugin's dist (the plugin's
      // node_modules has no `openclaw` entry — esbuild keeps it
      // external). Anchor the require to the openclaw install's
      // package.json via createRequire so Node's CommonJS resolver
      // walks up from there and finds the SDK subpath.
      const req = loadOpenClawSdk();
      if (req) {
        const sdk = req("./provider-auth-runtime.js") as {
          resolveApiKeyForProvider?: (
            p: Record<string, unknown>,
          ) => Promise<ResolvedNvidiaAuth | null | undefined>;
        };
        if (sdk && typeof sdk.resolveApiKeyForProvider === "function") {
          const resolved = await sdk.resolveApiKeyForProvider({
            provider: "nvidia",
            cfg: options.cfg as unknown as Record<string, unknown>,
            profileId: options.profileId,
            agentDir: options.agentDir,
          });
          const apiKey = resolved?.apiKey;
          if (typeof apiKey === "string" && apiKey.trim().length > 0) {
            return apiKey.trim();
          }
        }
      }
    } catch {
      // SDK errored — fall through to the legacy chain.
    }
  }

  // 3) Legacy chain: explicit env → shell profile → throw.
  return resolveApiKey({
    envVar,
    ...(options.env ? { env: options.env } : {}),
    ...(options.profileReader ? { profileReader: options.profileReader } : {}),
  });
}

/**
 * Build a memoised async resolver for the NVIDIA API key.
 *
 * Use this in plugin factories so the expensive runtime auth lookup runs
 * at most once per factory lifetime. After the first resolution, the
 * memoised function returns synchronously from cache. On failure the
 * legacy chain is consulted so unit tests / dev shells keep working.
 *
 * Example:
 *   const getApiKey = createCachedNvidiaApiKeyResolver({
 *     cfg: api.config,
 *     agentDir,
 *     profileReader: buildDefaultProfileReader(),
 *   });
 *   const apiKey = await getApiKey(); // first call: hits profile store
 *   const apiKey2 = await getApiKey(); // subsequent: cache hit
 */
export interface CachedNvidiaApiKeyResolverOptions
  extends ResolveNvidiaApiKeyOptions {}

export interface CachedNvidiaApiKeyResolver {
  (): Promise<string>;
  /** Synchronous peek at the cached value; undefined until first resolve. */
  readonly peek: () => string | undefined;
  /** Force a re-resolve on the next call. */
  readonly invalidate: () => void;
}

export function createCachedNvidiaApiKeyResolver(
  options: CachedNvidiaApiKeyResolverOptions = {},
): CachedNvidiaApiKeyResolver {
  let cached: { value: string } | undefined;
  let inflight: Promise<string> | undefined;

  const doResolve = (): Promise<string> => {
    inflight = resolveNvidiaApiKey(options)
      .then((value) => {
        cached = { value };
        return value;
      })
      .catch((err) => {
        // Don't cache failures — let the next call retry (e.g. after the
        // user adds a profile). Re-throw so callers see the real error.
        throw err;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };

  const fn = (): Promise<string> => {
    if (cached) return Promise.resolve(cached.value);
    if (inflight) return inflight;
    return doResolve();
  };

  return Object.assign(fn, {
    peek: () => cached?.value,
    invalidate: () => {
      cached = undefined;
    },
  });
}
