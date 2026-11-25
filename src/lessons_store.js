// Historical lesson and episode formats, retained for reading and migration.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hasSecret } from "./secrets.js";

export const lessonsDir = (root = process.cwd()) => join(root, ".forge", "lessons");

const csv = (arr) => (arr ?? []).join(", ");
const listOf = (v) =>
  v
    ? v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

/** Pure: lesson object → file text (flat front-matter + markdown body). */
export function serialize(lesson) {
  const t = lesson.trigger ?? {};
  const fm = [
    `id: ${lesson.id}`,
    `status: ${lesson.status}`,
    `scope: ${lesson.scope}`,
    `trigger.files: ${csv(t.files)}`,
    `trigger.symbols: ${csv(t.symbols)}`,
    `trigger.keywords: ${csv(t.keywords)}`,
    `trigger.action: ${t.action ?? ""}`,
    `evidence: ${lesson.evidenceCount}`,
    `contradiction: ${lesson.contradictionCount}`,
    `quarantineReconfirms: ${lesson.quarantineReconfirms}`,
    `created: ${lesson.createdDay}`,
    `lastConfirmed: ${lesson.lastConfirmedDay}`,
    `halfLifeDays: ${lesson.halfLifeDays}`,
    `episodes: ${csv(lesson.provenance?.episodes)}`,
    `signals: ${csv(lesson.provenance?.signals)}`,
  ].join("\n");
  return `---\n${fm}\n---\n\n${lesson.whatWentWrong}\n\n**Fix:** ${lesson.correctedBehavior}\n`;
}

/** Pure: file text → lesson object (inverse of serialize). */
export function parse(text) {
  const m = text.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error("invalid lesson file (no front-matter)");
  const fm = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  function number(field, fallback) {
    if (fm[field] === undefined || fm[field] === "") return fallback;
    const value = Number(fm[field]);
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(`invalid lesson file (${field})`);
    return value;
  }
  const body = m[2].trim();
  const [whatWentWrong] = body.split(/\n\n\*\*Fix:\*\*/);
  const fix = body.match(/\*\*Fix:\*\*\s*([\s\S]*)$/);
  return {
    id: fm.id,
    status: fm.status,
    scope: fm.scope,
    trigger: {
      files: listOf(fm["trigger.files"]),
      symbols: listOf(fm["trigger.symbols"]),
      keywords: listOf(fm["trigger.keywords"]),
      action: fm["trigger.action"] || undefined,
    },
    whatWentWrong: whatWentWrong.trim(),
    correctedBehavior: fix ? fix[1].trim() : "",
    evidenceCount: number("evidence", 0),
    contradictionCount: number("contradiction", 0),
    quarantineReconfirms: number("quarantineReconfirms", 0),
    createdDay: number("created", 0),
    lastConfirmedDay: number("lastConfirmed", 0),
    halfLifeDays: number("halfLifeDays", 45),
    provenance: { episodes: listOf(fm.episodes), signals: listOf(fm.signals) },
  };
}

/** Validate the complete lesson, including provenance, before writing a claim. */
export const lessonIsSafe = (lesson) => !hasSecret(serialize(lesson));

/** Append a correction episode to the audit log (independent evidence, never overwritten). */
export function appendEpisode(root, episode) {
  const dir = lessonsDir(root);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "episodes.jsonl"), `${JSON.stringify(episode)}\n`);
}

export function readEpisodes(root) {
  const path = join(lessonsDir(root), "episodes.jsonl");
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line)); // one corrupt JSONL line must not discard the whole log
    } catch {}
  }
  return out;
}
