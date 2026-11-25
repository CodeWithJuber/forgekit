// Personal preferences only: repository content cannot opt a developer into model calls.
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { privateWorkspaceFile } from "./workspace_preference.js";

const defaults = { recommendations: true, decisions: false, search: "off", model: "jev-latest" };

function validate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected discovery preferences");
  for (const [key, v] of Object.entries(value)) {
    if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown discovery preference: ${key}`);
    if (["decisions", "recommendations"].includes(key) && typeof v !== "boolean")
      throw new Error(`${key} must be on or off`);
    if (key === "search" && !["off", "serper", "brave"].includes(v))
      throw new Error("Choose search off, serper or brave");
    if (key === "model" && (typeof v !== "string" || !/^jev-[a-z0-9.-]{1,70}$/i.test(v)))
      throw new Error("Supply a TypeSafe Jev model ID");
  }
  return value;
}

function paths(root) {
  const repo = privateWorkspaceFile(root, "discovery");
  return { repo, global: join(dirname(repo), "global.json") };
}

function read(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return {};
  if (!stat.isFile() || stat.size > 4096) throw new Error("Invalid discovery preferences");
  return validate(JSON.parse(readFileSync(path, "utf8")));
}

/** Environment > personal workspace > personal global > defaults. Never reads repo config. */
export function advisorSettings(root = process.cwd(), env = process.env) {
  const warnings = [];
  let saved = {};
  try {
    const files = paths(root);
    saved = { ...read(files.global), ...read(files.repo) };
  } catch {
    saved = { decisions: false, recommendations: false, search: "off" };
    warnings.push("Personal discovery preferences unavailable; reset or reconfigure them.");
  }
  const settings = { ...defaults, ...saved };
  if (env.FORGE_LLM !== undefined) settings.decisions = env.FORGE_LLM === "1";
  if (env.FORGE_EVIDENCE_WEB !== undefined)
    settings.recommendations = env.FORGE_EVIDENCE_WEB !== "0";
  if (env.FORGE_WEB_SEARCH_PROVIDER !== undefined) settings.search = env.FORGE_WEB_SEARCH_PROVIDER;
  return { ...settings, warnings };
}

/** Null removes this scope's override. Never accepts or stores API credentials. */
export function configureAdvisor(root, patch, { global = false } = {}) {
  if (patch !== null) validate(patch);
  const file = paths(root)[global ? "global" : "repo"];
  if (patch === null) rmSync(file, { force: true });
  else {
    let prior = {};
    try {
      prior = read(file);
    } catch {
      // Explicit setup can repair a damaged personal record.
    }
    const value = validate({ ...prior, ...patch });
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${randomUUID()}`;
    try {
      writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      renameSync(tmp, file);
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  return { scope: global ? "global" : "workspace", path: file, settings: advisorSettings(root) };
}

export function discoveryStatus(root = process.cwd()) {
  const settings = advisorSettings(root);
  const key = settings.search === "serper" ? "SERPER_API_KEY" : "BRAVE_SEARCH_API_KEY";
  return {
    ...settings,
    offline: process.env.FORGE_NO_CATALOG_FETCH === "1",
    jevReady: settings.decisions && Boolean(process.env.TYPESAFE_API_KEY),
    searchReady: ["serper", "brave"].includes(settings.search) && Boolean(process.env[key]),
    setup: [
      "Set TYPESAFE_API_KEY in the environment of the CLI and your agent host for typed decisions.",
      "For Google, select --search serper and set SERPER_API_KEY; Brave uses BRAVE_SEARCH_API_KEY.",
      "GitHub, npm and Stack Overflow public discovery require no API key.",
    ],
  };
}
