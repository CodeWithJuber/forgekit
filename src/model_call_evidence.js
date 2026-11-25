// Record the latest call result under its exact transport, credential scope and wire model.
// The inventory never scans prompts, request bodies or transcripts.
import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { SAFE_MODEL_ID } from "./model_catalog.js";
import { modelScope } from "./model_scope.js";
import { outsideWorkspace } from "./private_paths.js";
import { privateWorkspaceFile } from "./workspace_preference.js";

const digest = (s) => createHash("sha256").update(s).digest("hex");

function evidenceDir(root, profile, key) {
  const scope = modelScope(
    root,
    "model-call",
    [
      profile.name,
      new URL(profile.baseUrl).href,
      profile.format ?? null,
      profile.type,
      profile.envKey || "",
    ],
    key || "",
  );
  if (!scope) return null;
  return outsideWorkspace(
    root,
    join(privateWorkspaceFile(root, "model-calls").slice(0, -5), scope),
    "Model call metadata must stay outside the workspace",
  );
}

export function recordModelCall(root, profile, key, row) {
  if (!SAFE_MODEL_ID.test(row.sent)) return;
  const dir = evidenceDir(root, profile, key);
  if (!dir) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, digest(row.sent) + ".json");
  const tmp = join(dir, "." + randomUUID());
  try {
    writeFileSync(
      tmp,
      JSON.stringify({
        sent: row.sent,
        returned: SAFE_MODEL_ID.test(row.returned ?? "") ? row.returned : null,
        at: row.at,
        status: row.status,
        latencyMs: row.latencyMs,
        costUsd: Number.isFinite(row.costUsd) && row.costUsd >= 0 ? row.costUsd : null,
      }),
      { flag: "wx", mode: 0o600 },
    );
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function readModelCalls(root, profile, key) {
  const rows = new Map();
  let dir;
  try {
    dir = evidenceDir(root, profile, key);
    if (!dir) return rows;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[0-9a-f]{64}\.json$/.test(entry.name)) continue;
      const path = join(dir, entry.name);
      const st = lstatSync(path);
      if (!st.isFile() || st.nlink !== 1 || st.size > 2048) continue;
      try {
        const row = JSON.parse(readFileSync(path, "utf8"));
        if (
          typeof row.sent === "string" &&
          SAFE_MODEL_ID.test(row.sent) &&
          digest(row.sent) + ".json" === entry.name &&
          ["success", "denied"].includes(row.status) &&
          Number.isFinite(row.at) &&
          Number.isFinite(row.latencyMs)
        )
          rows.set(row.sent, row);
      } catch {}
    }
  } catch {}
  return rows;
}
