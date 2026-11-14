// Local readers consume the already checked bytes. The expensive PDF path is selected
// in the user's source config and starts only inside an operating-system network guard.
import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "./secrets.js";

const office = fileURLToPath(new URL("./source_office.py", import.meta.url));
const docling = fileURLToPath(new URL("./source_docling.py", import.meta.url));

export function doclingConfig(root, config) {
  if (config === undefined) return null;
  if (
    config === null ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    !["scans", "layout"].includes(config.mode)
  )
    throw new Error("Set docling.mode to scans or layout");
  let artifactsPath = null;
  if (config.artifactsPath !== undefined || config.mode === "layout") {
    if (typeof config.artifactsPath !== "string" || !isAbsolute(config.artifactsPath))
      throw new Error("Layout extraction needs an absolute local artifactsPath");
    artifactsPath = realpathSync.native(config.artifactsPath);
    const rel = relative(root, artifactsPath);
    if (
      (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)) ||
      !statSync(artifactsPath).isDirectory()
    )
      throw new Error("Use a prefetched Docling model directory outside the indexed source");
  }
  const languages = config.languages ?? ["eng"];
  if (
    !Array.isArray(languages) ||
    !languages.length ||
    languages.length > 8 ||
    !languages.every((l) => typeof l === "string" && /^[a-z]{3}(?:_[A-Za-z]{3,6})?$/.test(l))
  )
    throw new Error("Set docling.languages to installed Tesseract codes such as eng or ara");
  return { mode: config.mode, artifactsPath, languages };
}

export function extractDocument(ext, bytes, cap, config = null) {
  const enhanced = ext === ".pdf";
  const python = process.platform === "win32" ? "python" : "python3";
  let command = python;
  let args = enhanced
    ? ["-I", docling, config.artifactsPath ?? "", config.languages.join(","), config.mode]
    : ["-I", office, ext];
  const env = { ...process.env };
  if (enhanced && process.platform === "darwin") {
    command = "/usr/bin/sandbox-exec";
    args = ["-p", "(version 1)(allow default)(deny network*)", python, ...args];
    env.FORGE_DOCLING_SANDBOXED = "1";
  }
  const proc = spawnSync(command, args, {
    input: bytes,
    env,
    timeout: enhanced ? 120000 : 10000,
    maxBuffer: 9 * 1024 * 1024,
    encoding: "utf8",
  });
  if (proc.status !== 0 || proc.error)
    throw new Error(
      enhanced
        ? "Offline Docling worker unavailable or exceeded its resource limit"
        : "Office extraction requires Python 3 and a readable OOXML document",
    );
  const result = JSON.parse(proc.stdout);
  if (result.error) throw new Error(result.error);
  const chunks = [];
  let truncated = false;
  // Group consecutive paragraphs so short Word paragraphs do not consume a whole
  // context slot apiece. Tables, slides and PDF pages keep distinct locations.
  let group = null;
  function flush() {
    if (!group) return;
    if (chunks.length >= cap) truncated = true;
    else
      chunks.push({
        text: group.text,
        locator:
          group.start === group.end
            ? `paragraph ${group.start}`
            : `paragraphs ${group.start}-${group.end}`,
      });
    group = null;
  }
  for (const [locator, raw] of result.sections) {
    const text = redactSecrets(raw).trim();
    if (!text) continue;
    const para = /^paragraph (\d+)$/.exec(locator);
    if (para && text.length <= 1600) {
      if (group && group.text.length + 1 + text.length > 1600) flush();
      const n = Number(para[1]);
      if (group) {
        group.end = n;
        group.text += `\n${text}`;
      } else group = { start: n, end: n, text };
    } else {
      flush();
      for (let at = 0; at < text.length; at += 1600) {
        if (chunks.length >= cap) {
          truncated = true;
          break;
        }
        chunks.push({
          locator:
            text.length > 1600
              ? `${locator} / chars ${at + 1}-${Math.min(at + 1600, text.length)}`
              : locator,
          text: text.slice(at, at + 1600),
        });
      }
    }
    if (truncated) break;
  }
  flush();
  if (!chunks.length)
    throw new Error(
      enhanced
        ? "Offline Docling found no extractable text"
        : "No supported office document text found",
    );
  return { chunks, truncated, structure: result.structure };
}
