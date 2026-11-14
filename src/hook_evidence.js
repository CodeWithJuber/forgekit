// Context-less prompt events (Cursor/Copilot command hooks) defer retrieval until a tool
// result can carry it. Keep only the redacted query, scoped to this user, repo and session.
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { redactSecrets } from "./secrets.js";
import { userStateDir } from "./util.js";

const MAX_QUERY = 1600;
const MAX_AGE = 30 * 60 * 1000;

function queryPath(host, root, sessionId) {
  if (!sessionId || sessionId === "default") return null;
  const dir = join(userStateDir(), "hook-queries");
  const rel = relative(resolve(root), resolve(dir));
  if (!(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))) return null;
  const key = createHash("sha256")
    .update(JSON.stringify([host, resolve(root), sessionId]))
    .digest("hex");
  return { dir, path: join(dir, key) };
}

export function queueQuery(host, root, sessionId, query) {
  const file = queryPath(host, root, sessionId);
  if (!file) return;
  try {
    if (!query) {
      rmSync(file.path, { force: true });
      return;
    }
    mkdirSync(file.dir, { mode: 0o700, recursive: true });
    // Bound abandoned sessions too. Never follow a directory entry outside this private dir.
    for (const name of readdirSync(file.dir).slice(0, 256)) {
      const path = join(file.dir, name);
      try {
        if (Date.now() - statSync(path).mtimeMs > MAX_AGE) rmSync(path, { force: true });
      } catch {}
    }
    const tmp = `${file.path}.${randomUUID()}`;
    writeFileSync(tmp, redactSecrets(query.slice(0, MAX_QUERY * 2)).slice(0, MAX_QUERY), {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(tmp, file.path);
  } catch {}
}

export function takeQuery(host, root, sessionId) {
  const file = queryPath(host, root, sessionId);
  if (!file) return "";
  const tmp = `${file.path}.${randomUUID()}`;
  try {
    // Claim by rename so parallel tools cannot each inject the same prompt.
    renameSync(file.path, tmp);
    return Date.now() - statSync(tmp).mtimeMs <= MAX_AGE ? readFileSync(tmp, "utf8") : "";
  } catch {
    return "";
  } finally {
    try {
      rmSync(tmp, { force: true });
    } catch {}
  }
}

/** Get a diagnostic only for an explicit failure, never from incidental "error" in tool output. */
export function failureQuery(hook) {
  if (hook.is_interrupt || hook.failure_type === "permission_denied") return "";
  const response = hook.tool_response;
  const code =
    hook.exitCode ?? response?.exit_code ?? response?.exitCode ?? response?.metadata?.exit_code;
  // Codex's shell wrapper can expose the result as model-facing text, e.g. "Process exited
  // with code 1". Require the actual status header ahead of Output, never lines inside stdout.
  const status =
    hook.tool_name === "Bash" &&
    typeof response === "string" &&
    /^(?:Chunk ID:[^\n]*\r?\n)?(?:Wall time:[^\n]*\r?\n)?(?:Process exited with code|Exit code:)\s+[1-9]\d*\b/i.test(
      response,
    );
  const error =
    hook.error || (typeof response?.error === "string" ? response.error : response?.error?.message);
  if (!error && !response?.isError && !(typeof code === "number" && code !== 0) && !status)
    return "";
  const message =
    (typeof error === "string" ? error : error?.message) ||
    response?.stderr ||
    response?.output ||
    response?.stdout ||
    (typeof response === "string"
      ? response
      : response?.content?.find?.((item) => item?.type === "text")?.text);
  const detail = String(message || "").slice(-1200);
  const command =
    typeof hook.tool_input?.command === "string" ? hook.tool_input.command.slice(0, 300) : "";
  return redactSecrets(
    ["Troubleshoot", hook.tool_name, command, detail].filter(Boolean).join(" ").slice(0, MAX_QUERY),
  );
}

/** Advisory retrieval must never swallow an existing guard verdict when it fails. */
export async function hookEvidence(root, query, reuse = undefined) {
  if (!query?.trim()) return "";
  try {
    const { runEvidence } = await import("./evidence.js");
    const result = await runEvidence(query, { root, hook: true, reuse });
    return result.text || "";
  } catch {
    return "";
  }
}

/** Prompt events alone may enqueue an already-approved tool install. */
export async function autoAdoptionNotice(root, prompt) {
  try {
    const { maybeAutoAdopt } = await import("./auto_adoption.js");
    const job = maybeAutoAdopt(root, prompt);
    return job
      ? `Forge integration ${job.id}: ${job.state}. Check forge integrations auto status.`
      : "";
  } catch {
    return "";
  }
}
