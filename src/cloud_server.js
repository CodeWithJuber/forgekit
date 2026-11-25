// Self-hosted receiver. Only the operator selects the credential scope and backing store.

import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_FILE, MAX_FILES, MAX_TOTAL, sha, validPath, workspaceId } from "./cloud_snapshot.js";
import { installedHarnessProgram } from "./harness_python.js";

const worker = fileURLToPath(new URL("./cloud_store.py", import.meta.url));
const page = readFileSync(new URL("./cloud_dashboard.html", import.meta.url));
const digest = (s) => createHash("sha256").update(s).digest();
const uuid = (s) => typeof s === "string" && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(s);
const fail = (status, message) => Object.assign(new Error(message), { status });
function validateChange(c) {
  if (
    !c ||
    !uuid(c.id) ||
    !(c.parent === null || uuid(c.parent)) ||
    !Array.isArray(c.files) ||
    !Array.isArray(c.removed) ||
    c.files.length > MAX_FILES ||
    c.removed.length > MAX_FILES
  )
    throw fail(400, "Invalid snapshot change");
  const paths = new Set();
  let total = 0;
  function unique(p) {
    if (!validPath(p) || paths.has(p)) throw fail(400, "Invalid or duplicate file path");
    paths.add(p);
  }
  for (const f of c.files) {
    if (
      !f ||
      typeof f.content !== "string" ||
      f.content.length > Math.ceil(MAX_FILE / 3) * 4 ||
      !["text", "binary"].includes(f.kind) ||
      typeof f.redacted !== "boolean"
    )
      throw fail(400, "Invalid artifact");
    unique(f.path);
    const bytes = Buffer.from(f.content, "base64");
    if (
      bytes.length > MAX_FILE ||
      bytes.length !== f.bytes ||
      bytes.toString("base64") !== f.content ||
      sha(bytes) !== f.sha256
    )
      throw fail(400, "Artifact checksum mismatch");
    total += bytes.length;
  }
  for (const p of c.removed) unique(p);
  if (total > MAX_TOTAL) throw fail(413, "Workspace exceeds capacity");
}
function storage(python, database, query) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ["-I", worker, database], {
      stdio: ["pipe", "pipe", "ignore"],
      env: {
        ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
        PYTHONIOENCODING: "utf8",
      },
      windowsHide: true,
    });
    const chunks = [];
    let length = 0;
    const timer = setTimeout(() => child.kill(), 45000);
    child.stdout.on("data", (chunk) => {
      length += chunk.length;
      if (length > 64 * 1024 * 1024) {
        child.kill();
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error("Cloud store unavailable"));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (e) {
        reject(e);
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(query));
  });
}
async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || ""))
    throw fail(415, "Use application/json");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 180 * 1024 * 1024) throw fail(413, "Request exceeds limit");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw fail(400, "Malformed JSON");
  }
}
export function cloudService({ dataDir, principals }, env = process.env) {
  if (!dataDir || !isAbsolute(dataDir) || !Array.isArray(principals) || !principals.length)
    throw new Error("Provide an absolute private dataDir and scoped principals");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dataDir);
  if (
    !stat.isDirectory() ||
    realpathSync.native(dataDir) !== dataDir ||
    (process.platform !== "win32" && (stat.mode & 0o077 || stat.uid !== process.getuid()))
  )
    throw new Error("Cloud dataDir must be private to its owner");
  const database = join(dataDir, "cloud.sqlite");
  const dbstat = lstatSync(database, { throwIfNoEntry: false });
  if (
    dbstat &&
    (!dbstat.isFile() ||
      dbstat.nlink !== 1 ||
      (process.platform !== "win32" && (dbstat.mode & 0o077 || dbstat.uid !== process.getuid())))
  )
    throw new Error("Invalid cloud database");
  const python = installedHarnessProgram(
    process.cwd(),
    process.platform === "win32" ? "python" : "python3",
    [dirname(worker)],
  );
  const seen = new Set();
  const keys = principals.map((p) => {
    if (
      !workspaceId(p.tenant) ||
      !workspaceId(p.workspace) ||
      !["reader", "writer", "admin"].includes(p.role) ||
      !/^[A-Z_][A-Z_0-9]*$/i.test(p.tokenEnv) ||
      !Object.hasOwn(env, p.tokenEnv)
    )
      throw new Error("Invalid scoped cloud principal");
    const token = env[p.tokenEnv];
    if (typeof token !== "string" || token.length < 32 || seen.has(token))
      throw new Error("Use distinct scoped bearer credentials of at least 32 characters");
    seen.add(token);
    return {
      hash: digest(token),
      workspace: p.workspace,
      scope: `${p.tenant}/${p.workspace}`,
      role: p.role,
    };
  });
  let activeWrites = 0;
  const server = createServer(async (req, res) => {
    const json = (code, v) => {
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(v));
    };
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    try {
      const u = new URL(req.url, "http://localhost");
      if (req.method === "GET" && u.pathname === "/") {
        res.setHeader(
          "Content-Security-Policy",
          "default-src 'none'; script-src 'sha256-" +
            pageScriptHash +
            "'; style-src 'unsafe-inline'; img-src blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        );
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page);
        return;
      }
      const [, scope, action] =
        /^\/v1\/workspaces\/([a-z0-9_-]+)(?:\/(artifact|sync|events))?$/i.exec(u.pathname) || [];
      if (!scope) throw fail(404, "Unknown endpoint");
      const auth = req.headers.authorization;
      if (!auth?.startsWith("Bearer ")) throw fail(401, "Authentication required");
      const token = digest(auth.slice(7));
      const peer = keys.find((k) => timingSafeEqual(k.hash, token));
      if (!peer || peer.workspace !== scope) throw fail(403, "Access denied");
      let query;
      if (req.method === "GET" && !action) query = { op: "status" };
      else if (req.method === "GET" && action === "events") {
        const after = u.searchParams.get("after"),
          id = u.searchParams.get("id");
        if ((after && !uuid(after)) || (id && !uuid(id)) || (after && id))
          throw fail(400, "Invalid journal cursor");
        query = { op: "events", after, id };
      } else if (req.method === "GET" && action === "artifact") {
        if (peer.role === "writer") throw fail(403, "Reader authorization required");
        const path = u.searchParams.get("path");
        if (!validPath(path)) throw fail(400, "Invalid artifact path");
        query = { op: "artifact", path };
      } else if (req.method === "DELETE" && !action) {
        if (peer.role !== "admin") throw fail(403, "Admin authorization required");
        query = { op: "delete" };
      } else if (req.method === "POST" && action === "sync") {
        if (peer.role === "reader") throw fail(403, "Writer authorization required");
        if (activeWrites) throw fail(429, "Another upload is active");
        activeWrites++;
        try {
          const change = await body(req);
          validateChange(change);
          const result = await storage(python, database, { scope: peer.scope, op: "push", change });
          json(result.error ?? 200, result);
          return;
        } finally {
          activeWrites--;
        }
      } else throw fail(405, "Unsupported method");
      const result = await storage(python, database, { scope: peer.scope, ...query });
      json(result.error ?? 200, result);
    } catch (e) {
      if (!res.headersSent)
        json(e.status || 500, { error: e.status ? e.message : "Cloud operation failed" });
    }
  });
  server.requestTimeout = 60000;
  server.headersTimeout = 15000;
  return server;
}
const script = page.toString().match(/<script>([\s\S]+?)<\/script>/i)[1];
const pageScriptHash = createHash("sha256").update(script).digest("base64");
