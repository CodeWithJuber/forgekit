// forge lessons storage — persistence for the self-correcting core. Lessons are one
// file each under .forge/lessons/ (git-committable, human-auditable), episodes are an
// append-only JSONL. Flat front-matter, not YAML: zero runtime deps and still readable/
// diffable. Secret-refusal is reused from recall (never persist a credential).
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { SECRET_RE } from "./recall.js";

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
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error("invalid lesson file (no front-matter)");
  const fm = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
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
    evidenceCount: Number(fm.evidence) || 0,
    contradictionCount: Number(fm.contradiction) || 0,
    quarantineReconfirms: Number(fm.quarantineReconfirms) || 0,
    createdDay: Number(fm.created) || 0,
    lastConfirmedDay: Number(fm.lastConfirmed) || 0,
    halfLifeDays: Number(fm.halfLifeDays) || 45,
    provenance: { episodes: listOf(fm.episodes), signals: listOf(fm.signals) },
  };
}

/** Persist one lesson. Refuses secret-like content (store a pointer, never the value). */
export function save(root, lesson) {
  const text = serialize(lesson);
  if (SECRET_RE.test(text)) {
    return {
      ok: false,
      reason: "refused: lesson looks like it contains a secret/credential",
    };
  }
  const dir = lessonsDir(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${lesson.id}.md`), text);
  return { ok: true };
}

/** Load every persisted lesson (episodes.jsonl is skipped — only .md files are lessons).
 *  A single malformed/half-written file is skipped, not fatal — one bad file must never take
 *  down memory retrieval, routing, and the pre-edit advisory (everywhere `load` is called). */
export function load(root) {
  const dir = lessonsDir(root);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()) {
    try {
      out.push(parse(readFileSync(join(dir, f), "utf8")));
    } catch (err) {
      if (process.env.FORGE_DEBUG === "1")
        process.stderr.write(`forge lessons: skipping ${f}: ${err?.message ?? err}\n`);
    }
  }
  return out;
}

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
