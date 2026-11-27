// Feed bytes that the caller already read and bounded to a child process.
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Run a converter on bytes the caller already read and bounded. The child reads them from a
 * private regular file on stdin, never from a pipe the parent writes into while it
 * waits: a large piped write stalled a reader on macOS until the timeout, and a file
 * has a fixed end the child reaches on its own. The child still never opens a path.
 * @param {string} cmd
 * @param {string[]} args
 * @param {Uint8Array} bytes
 * @param {Omit<import("node:child_process").SpawnSyncOptions, "stdio" | "input" | "encoding">} options
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
export function spawnOnBytes(cmd, args, bytes, options) {
  const dir = mkdtempSync(join(tmpdir(), "forge-input-"));
  try {
    const file = join(dir, "input");
    writeFileSync(file, bytes, { mode: 0o600, flag: "wx" });
    const fd = openSync(file, "r");
    try {
      return spawnSync(cmd, args, { ...options, encoding: "utf8", stdio: [fd, "pipe", "pipe"] });
    } finally {
      closeSync(fd);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
