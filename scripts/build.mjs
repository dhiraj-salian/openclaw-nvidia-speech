#!/usr/bin/env node
import { build } from "esbuild";
import { rm, mkdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const DIST = "dist";

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

await build({
  entryPoints: ["src/index.ts"],
  outfile: `${DIST}/index.js`,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  treeShaking: true,
  // OpenClaw's plugin SDK is provided by the host; never bundle it.
  external: ["openclaw/*"],
  logLevel: "info",
});

// Copy the manifest alongside the built entry so `openclaw plugins install ./` works.
if (existsSync("openclaw.plugin.json")) {
  await copyFile("openclaw.plugin.json", `${DIST}/openclaw.plugin.json`);
}

console.log("✓ build complete →", DIST);
