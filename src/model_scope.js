// Keep account-scoped cache identifiers unlinkable across installations. A copied
// cache name alone must not let someone test guesses about a provider credential.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { outsideWorkspace } from "./private_paths.js";
import { userStateDir } from "./util.js";

const processKey = randomBytes(32);

function readKey(path) {
  if (!lstatSync(path).isFile()) throw new Error("Invalid model cache key");
  const fd = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = fstatSync(fd);
    const key = Buffer.alloc(32);
    if (
      !stat.isFile() ||
      stat.size !== key.length ||
      readSync(fd, key, 0, key.length, 0) !== key.length
    )
      throw new Error("Invalid model cache key");
    return key;
  } finally {
    closeSync(fd);
  }
}

function installationKey(dir) {
  const path = join(dir, "model-scope.key");
  try {
    return readKey(path);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.model-scope-${randomUUID()}`);
  try {
    writeFileSync(temp, randomBytes(32), { flag: "wx", mode: 0o600 });
    try {
      linkSync(temp, path);
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  } finally {
    rmSync(temp, { force: true });
  }
  return readKey(path);
}

/** Null disables disk caching when private state cannot be read or created. */
export function modelScope(root, purpose, fields) {
  let key = processKey;
  if (root) {
    const dir = outsideWorkspace(
      root,
      userStateDir(),
      "Model credentials require private user state",
    );
    try {
      key = installationKey(dir);
    } catch {
      return null;
    }
  }
  return createHmac("sha256", key)
    .update(JSON.stringify([purpose, fields]))
    .digest("hex");
}
