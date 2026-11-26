// Recover reviewed project memory from the committed Markdown in a fresh checkout.
// The journal records content. Only a full ledger sync restores evidence and retractions.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { decisionClaim, parseDecisions } from "./decide.js";
import { SCOPE_WEIGHT } from "./ledger.js";
import { factClaim, lessonClaim } from "./ledger_bridge.js";
import { ensureLocalIgnored, hasStoredClaim, putClaim, repoLedger } from "./ledger_store.js";
import { parse as parseLesson } from "./lessons_store.js";
import { parseFact } from "./recall.js";
import { readForgeConfig } from "./repo_config.js";

const journal = ".forge/decisions.md";
const provenance = { agent: "project-memory" };
const batchLimit = 4 * 1024 * 1024;
const memoryBlob =
  /^100(?:644|755) blob ([a-f0-9]+)\s+(\d+)\t(\.forge\/(?:decisions\.md|(?:brain\/facts|lessons)\/[^/]+\.md))$/u;

function debug(message) {
  if (process.env.FORGE_DEBUG === "1") process.stderr.write(`forge memory: ${message}\n`);
}

function recoverFile(path, text, put) {
  if (path === journal) {
    for (const { id, text: body, date } of parseDecisions(text)) {
      const t = Date.parse(date) / 86_400_000;
      if (body && Number.isInteger(t)) put("decisions", decisionClaim(id, body, t, provenance));
    }
  } else if (path.startsWith(".forge/lessons/")) {
    let lesson;
    try {
      lesson = parseLesson(text.replace(/\r\n/g, "\n"));
    } catch (err) {
      debug(`${path}: ${err.message}`);
      return;
    }
    if (
      lesson.id !== basename(path, ".md") ||
      !Object.hasOwn(SCOPE_WEIGHT, lesson.scope) ||
      !lesson.correctedBehavior ||
      !["candidate", "active"].includes(lesson.status)
    )
      return;
    put("lessons", lessonClaim(lesson, lesson.createdDay, { ...provenance, author: "" }));
  } else {
    const { name, text: body } = parseFact(text, basename(path, ".md"));
    if (name && body) put("facts", factClaim(name, body, 0, 0, provenance));
  }
}

export function restoreProjectMemory(root, { force = false } = {}) {
  const counts = { decisions: 0, facts: 0, lessons: 0 };
  const paths = [journal];
  if (readForgeConfig(root).portableMemory === true)
    paths.push(".forge/brain/facts", ".forge/lessons");
  if (!paths.some((p) => existsSync(join(root, p)))) return counts;
  const dir = repoLedger(root);
  const marker = join(dir, "project-memory.stamp");
  const git = (args, options = {}) =>
    execFileSync("git", args, {
      cwd: root,
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 5000,
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
      ...options,
    });
  try {
    // ls-tree and cat-file read HEAD, independent of partial, staged or unsaved edits.
    const tree = git(["ls-tree", "-rzl", "HEAD", "--", ...paths]).toString();
    const entries = tree.split("\0").flatMap((row) => {
      const match = memoryBlob.exec(row);
      if (!match) return [];
      const [, oid, length, path] = match;
      const size = Number(length);
      if (size > batchLimit) {
        debug(`skipping ${path} (over ${batchLimit} bytes)`);
        return [];
      }
      return [{ oid, size, path }];
    });
    if (!entries.length) return counts;
    const stamp = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
    if (!force && existsSync(marker) && readFileSync(marker, "utf8") === stamp) return counts;
    const put = (kind, minted) => {
      if (!minted.ok || hasStoredClaim(dir, minted.claim.id)) return;
      const result = putClaim(dir, minted.claim);
      if (result.ok && !result.existed) counts[kind]++;
    };
    // Stream one batch of blobs at a time. Use Git's byte lengths, including for Unicode text.
    let index = 0;
    while (index < entries.length) {
      const batch = [];
      let bytes = 0;
      do {
        const entry = entries[index++];
        batch.push(entry);
        bytes += entry.size + 128;
      } while (index < entries.length && bytes + entries[index].size + 128 <= batchLimit);
      const data = git(["cat-file", "--batch"], {
        input: `${batch.map((e) => e.oid).join("\n")}\n`,
        maxBuffer: bytes,
      });
      let offset = 0;
      for (const { oid, size, path } of batch) {
        const next = data.indexOf(10, offset);
        if (next < 0 || data.toString("ascii", offset, next) !== `${oid} blob ${size}`)
          throw new Error(`Git object unavailable for ${path}`);
        const end = next + 1 + size;
        if (data[end] !== 10) throw new Error(`incomplete Git object for ${path}`);
        recoverFile(path, data.toString("utf8", next + 1, end), put);
        offset = end + 1;
      }
    }
    mkdirSync(dir, { recursive: true });
    ensureLocalIgnored(dir, "project-memory.stamp*", "local index of committed Markdown");
    const temp = `${marker}.${randomUUID()}`;
    try {
      writeFileSync(temp, stamp, { flag: "wx", mode: 0o600 });
      renameSync(temp, marker);
    } finally {
      rmSync(temp, { force: true });
    }
  } catch (err) {
    debug(err.message);
  }
  return counts;
}
