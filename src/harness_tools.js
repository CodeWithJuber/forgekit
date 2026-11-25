// The supervised harness has a small, explicit local tool surface. Recheck paths in
// the executor: validation of a proposed call is not authority over a later file.
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  opendirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { secretKind } from "../global/guards/protect-paths.mjs";
import { containsPath, physicalPath } from "./private_paths.js";
import { hasSecret, redactSecrets } from "./secrets.js";
import { contentHash, userStateDir } from "./util.js";

const FILE_BYTES = 128 * 1024;
const READ_OUTPUT_BYTES = 20000;
const noFollow = constants.O_NOFOLLOW ?? 0;
const nonBlock = constants.O_NONBLOCK ?? 0;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const badName =
  /^(?:credentials?(?:[._-]|$)|secrets?(?:[._-]|$)|id_rsa|id_ed25519)|\.(?:pfx|p12|kdbx)$/i;
const safeSegment = (name) =>
  name &&
  !name.startsWith(".") &&
  name === name.trim() &&
  !name.endsWith(".") &&
  !/[\\:<>|"?*]/.test(name) &&
  !Array.from(name).some((ch) => ch.charCodeAt(0) < 32) &&
  !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) &&
  !badName.test(name);
function target(root, path, kind, request) {
  if (typeof path !== "string" || path.length > 1024)
    throw new Error("Expected a workspace-relative path");
  const base = realpathSync.native(root);
  const parts = path === "." && kind === "directory" ? [] : path.split("/");
  if (!parts.every(safeSegment) || secretKind(path, { cwd: base, dir: kind === "directory" }))
    throw new Error("Protected or non-workspace path");
  if (
    parts[0]?.toLowerCase() === "harness" ||
    parts.some((p) => p.toLowerCase() === "node_modules")
  )
    throw new Error("Harness configuration and dependency directories are outside tool scope");
  let resolved = base;
  for (const [i, part] of parts.entries()) {
    resolved = join(resolved, part);
    const s = lstatSync(resolved, { throwIfNoEntry: false });
    if (!s && kind === "write" && i === parts.length - 1) break;
    if (!s) throw Object.assign(new Error("Missing workspace path"), { code: "ENOENT" });
    if (s.isSymbolicLink() || (i < parts.length - 1 && !s.isDirectory()))
      throw new Error("Missing path, link, or non-directory in workspace path");
    if (
      i === parts.length - 1 &&
      (kind === "directory" ? !s.isDirectory() : !s.isFile() || s.nlink !== 1)
    )
      throw new Error("Expected an unlinked regular file or directory");
  }
  const state = physicalPath(userStateDir());
  if (containsPath(state, resolved))
    throw new Error("Tool access to private harness state is denied");
  const scope = request?.scope;
  if (kind === "write" && scope !== undefined) {
    if (
      !Array.isArray(scope) ||
      !scope.some(
        (s) => typeof s === "string" && (s === "." || s === path || path.startsWith(`${s}/`)),
      )
    )
      throw new Error("Path is outside the assigned write scope");
  }
  return resolved;
}

function snapshot(path) {
  const fd = openSync(path, constants.O_RDONLY | noFollow | nonBlock);
  try {
    const info = fstatSync(fd);
    if (info.size > FILE_BYTES)
      throw Object.assign(new Error("Refusing oversized file"), { code: "EFBIG" });
    const visible = lstatSync(path);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.dev !== visible.dev ||
      info.ino !== visible.ino ||
      realpathSync.native(path) !== path
    )
      throw new Error("Refusing linked, non-regular or oversized file");
    const buf = Buffer.alloc(FILE_BYTES + 1);
    let len = 0,
      n;
    while (len < buf.length && (n = readSync(fd, buf, len, buf.length - len, null)) > 0) len += n;
    if (len > FILE_BYTES)
      throw Object.assign(new Error("Refusing oversized file"), { code: "EFBIG" });
    if (buf.subarray(0, len).includes(0))
      throw Object.assign(new Error("Refusing binary file"), { code: "EBADMSG" });
    const after = lstatSync(path);
    if (
      after.dev !== info.dev ||
      after.ino !== info.ino ||
      after.nlink !== 1 ||
      realpathSync.native(path) !== path
    )
      throw new Error("Workspace file changed during read");
    const text = utf8.decode(buf.subarray(0, len));
    return { text, sha256: contentHash(text), mode: info.mode & 0o777 };
  } finally {
    closeSync(fd);
  }
}

/** Read only bounded ordinary workspace files. Reasons are safe to show to clients. */
export function workspaceEvidence(root, rel, { inspectOnly = false } = {}) {
  try {
    const file = target(
      root,
      typeof rel === "string" ? rel.replace(/^(?:\.\/)+/, "") : rel,
      "file",
      undefined,
    );
    if (inspectOnly) {
      const bytes = lstatSync(file).size;
      return bytes > FILE_BYTES
        ? { available: false, reason: "size-limit" }
        : { available: true, bytes };
    }
    const { text } = snapshot(file);
    return { available: true, text };
  } catch (err) {
    const reason =
      err.code === "ENOENT"
        ? "missing"
        : err.code === "EFBIG"
          ? "size-limit"
          : ["EBADMSG", "ERR_ENCODING_INVALID_ENCODED_DATA"].includes(err.code)
            ? "binary-or-invalid-utf8"
            : "protected-or-unreadable";
    return { available: false, reason };
  }
}

/** Portable evidence uses exactly the same file restrictions and digest as a guarded edit. */
export function workspaceFileDigest(root, path) {
  return snapshot(target(root, path, "file", undefined)).sha256;
}

const filePath = { type: "string", minLength: 1, maxLength: 1024 };
const schema = (properties, required) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

function validateWrite(args, { root, request }) {
  target(root, args.path, "write", request);
  if (args.expectedSha256 !== null && !/^[a-f0-9]{64}$/.test(args.expectedSha256))
    throw new Error("Expected a SHA-256 or null");
  if (Buffer.byteLength(args.content) > FILE_BYTES || args.content.includes("\0"))
    throw new Error("Refusing binary or oversized content");
  if (hasSecret(args.content)) throw new Error("Refusing secret-shaped content");
}

export function createHarnessTools() {
  return [
    {
      name: "read_file",
      description:
        "Read a context-sized UTF-8 file page. Continue using nextOffset and expectedSha256 from the response.",
      risk: "read",
      idempotency: "safe",
      timeoutMs: 5000,
      outputCapBytes: READ_OUTPUT_BYTES,
      inputSchema: schema(
        {
          path: filePath,
          offset: { type: "integer", minimum: 0, maximum: FILE_BYTES },
          expectedSha256: { type: "string", minLength: 64, maxLength: 64 },
        },
        ["path"],
      ),
      validate(args, { root, request }) {
        target(root, args.path, "file", request);
      },
      execute(args, { root, request, readPageBytes = READ_OUTPUT_BYTES }) {
        const { text, sha256 } = snapshot(target(root, args.path, "file", request));
        if (args.expectedSha256 !== undefined && args.expectedSha256 !== sha256)
          throw new Error("File changed between pages; restart at offset 0");
        const safe = redactSecrets(text);
        const start = args.offset ?? 0;
        if (
          !Number.isSafeInteger(start) ||
          start < 0 ||
          start > safe.length ||
          (start < safe.length &&
            safe.charCodeAt(start) >= 0xdc00 &&
            safe.charCodeAt(start) <= 0xdfff)
        )
          throw new Error("Invalid read offset");
        const cap = Math.min(READ_OUTPUT_BYTES, readPageBytes);
        const page = { path: args.path, sha256, nextOffset: null, content: "" };
        const envelope = Buffer.byteLength(JSON.stringify(page));
        // nextOffset is a UTF-16 index in the complete redacted text (existing API).
        // Reserve its largest possible serialization, then count each escaped code point.
        const available = cap - envelope - Math.max(0, String(safe.length).length - "null".length);
        let used = 0;
        let next = start;
        for (const ch of safe.slice(start)) {
          const bytes = Buffer.byteLength(JSON.stringify(ch)) - 2;
          if (used + bytes > available) break;
          used += bytes;
          next += ch.length;
        }
        if (available < 0 || (next === start && next < safe.length))
          throw new Error("Context window too small for a read page; increase contextTokens");
        page.content = safe.slice(start, next);
        page.nextOffset = next < safe.length ? next : null;
        return page;
      },
    },
    {
      name: "list_files",
      description: "List up to 100 visible, eligible direct children of a workspace directory.",
      risk: "read",
      idempotency: "safe",
      timeoutMs: 5000,
      outputCapBytes: 20000,
      inputSchema: schema({ path: filePath }, []),
      validate(args, { root, request }) {
        target(root, args.path ?? ".", "directory", request);
      },
      execute(args, { root, request }) {
        const path = args.path ?? ".",
          resolved = target(root, path, "directory", request);
        const entries = [],
          dir = opendirSync(resolved);
        let scanned = 0;
        try {
          let item;
          while (scanned < 1000 && (item = dir.readSync()) !== null) {
            scanned++;
            if (!item.isFile() && !item.isDirectory()) continue;
            const child = path === "." ? item.name : `${path}/${item.name}`;
            try {
              target(root, child, item.isDirectory() ? "directory" : "file", request);
            } catch {
              continue;
            }
            entries.push({ name: item.name, type: item.isDirectory() ? "directory" : "file" });
            if (entries.length === 100) break;
          }
        } finally {
          dir.closeSync();
        }
        return { path, entries, truncated: entries.length === 100 || scanned === 1000 };
      },
    },
    {
      name: "write_file",
      description:
        "Create or replace a UTF-8 workspace file. Supply expectedSha256 from read_file, or null to create only.",
      risk: "write-local",
      idempotency: "same-key",
      timeoutMs: 5000,
      outputCapBytes: 20000,
      inputSchema: schema(
        {
          path: filePath,
          content: { type: "string", maxLength: FILE_BYTES },
          expectedSha256: { type: ["string", "null"] },
        },
        ["path", "content", "expectedSha256"],
      ),
      validate: validateWrite,
      execute(args, ctx) {
        validateWrite(args, ctx);
        const path = target(ctx.root, args.path, "write", ctx.request);
        // Serialize ForgeKit writers. A create is published by link so it can never
        // replace an independently created file. Replacement verifies the prior hash.
        const lock = join(
          dirname(path),
          `.forge-write-${contentHash(basename(path).toLowerCase())}.lock`,
        );
        const fd = openSync(lock, "wx", 0o600);
        const temp = join(dirname(path), `.forge-write-${randomUUID()}`);
        try {
          const old = lstatSync(path, { throwIfNoEntry: false }) ? snapshot(path) : null;
          if ((old?.sha256 ?? null) !== args.expectedSha256)
            throw new Error("File changed since it was read");
          const out = openSync(temp, "wx", old?.mode ?? 0o600);
          try {
            writeFileSync(out, args.content, "utf8");
            fsyncSync(out);
          } finally {
            closeSync(out);
          }
          target(ctx.root, args.path, "write", ctx.request);
          if (old) {
            if (snapshot(path).sha256 !== old.sha256) throw new Error("File changed during edit");
            renameSync(temp, path);
          } else linkSync(temp, path);
          return {
            path: args.path,
            sha256: contentHash(args.content),
            bytes: Buffer.byteLength(args.content),
          };
        } finally {
          closeSync(fd);
          try {
            rmSync(temp, { force: true });
          } finally {
            unlinkSync(lock);
          }
        }
      },
    },
  ];
}
