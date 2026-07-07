// forge util — shared micro-utilities. Extracted from duplicated copies across
// cortex.js, recall.js, cortex_hook.js, doctor.js, harden.js, route.js, adjudicate.js,
// scope.js, atlas.js, preflight.js, and cortex_hook_main.js.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

export const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

export const clamp01 = (x) => Math.max(0, Math.min(1, x));

export const MS_PER_DAY = 86400000;
export const epochDay = () => Math.floor(Date.now() / MS_PER_DAY);

export function hasBin(bin) {
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function contentHash(text) {
  return createHash("sha256").update(text).digest("hex");
}

export const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "out",
  "target",
  "__pycache__",
  ".forge",
  "coverage",
  ".venv",
  "vendor",
]);

export const SRC_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|py)$/;

export const CODE_EXT =
  /\.(js|ts|jsx|tsx|mjs|cjs|py|go|rs|java|rb|php|c|cc|cpp|h|hpp|cs|json|ya?ml|toml|md|css|scss|html|vue|svelte)$/i;
