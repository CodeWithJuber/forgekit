// The envelope runs the same command entry point, including its stdout, stderr and exit status.

import { isUtf8 } from "node:buffer";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("./cli.js", import.meta.url));
const streamLimit = 8 * 1024 * 1024;

function capture() {
  return { chunks: [], bytes: 0, kept: 0 };
}

function append(target, bytes, limit) {
  target.bytes += bytes.length;
  const n = Math.min(bytes.length, limit - target.kept);
  if (n > 0) {
    target.chunks.push(bytes.subarray(0, n));
    target.kept += n;
  }
}

function payload(target) {
  const bytes = Buffer.concat(target.chunks);
  const truncated = target.bytes !== target.kept;
  const meta = { bytes: target.bytes, truncated };
  if (!isUtf8(bytes)) return { ...meta, kind: "binary", base64: bytes.toString("base64") };
  const value = bytes.toString("utf8");
  if (!truncated && value.trim()) {
    try {
      return { ...meta, kind: "json", value: JSON.parse(value) };
    } catch {
      // Human-readable command output is valid in the envelope too.
    }
  }
  return { ...meta, kind: "text", value };
}

async function record(value) {
  if (!process.stdout.write(`${JSON.stringify(value)}\n`)) await once(process.stdout, "drain");
}

export async function runWithOutput(mode, args) {
  if (!["json-v1", "jsonl-v1"].includes(mode))
    throw new Error("Use --output=json-v1 or --output=jsonl-v1");
  if (args[0]?.startsWith("--output=")) throw new Error("Specify the output envelope once");
  const streaming = mode === "jsonl-v1";
  const header = { schemaVersion: 1, command: args[0] ?? "help" };
  const child = spawn(process.execPath, [entry, ...args], { stdio: ["inherit", "pipe", "pipe"] });
  const done = new Promise((resolve) => {
    child.once("error", (error) => resolve({ exitCode: 1, signal: null, error: error.message }));
    child.once("close", (code, signal) =>
      resolve({
        exitCode: code ?? 128 + (constants.signals[signal] ?? 0),
        signal,
      }),
    );
  });
  const forward = new Map(
    ["SIGINT", "SIGTERM"].map((signal) => [
      signal,
      () => child.kill(/** @type {NodeJS.Signals} */ (signal)),
    ]),
  );
  for (const [signal, listener] of forward) process.on(signal, listener);
  try {
    if (streaming) await record({ ...header, event: "started" });
    async function read(stream, name) {
      const captured = capture();
      for await (const chunk of stream) {
        if (streaming) await record({ ...header, event: name, base64: chunk.toString("base64") });
        else append(captured, chunk, streamLimit);
      }
      return captured;
    }
    const [stdout, stderr, status] = await Promise.all([
      read(child.stdout, "stdout"),
      read(child.stderr, "stderr"),
      done,
    ]);
    if (streaming) await record({ ...header, event: "exit", ...status });
    else
      await record({
        ...header,
        ...status,
        complete: stdout.bytes === stdout.kept && stderr.bytes === stderr.kept,
        stdout: payload(stdout),
        stderr: payload(stderr),
      });
    process.exitCode = status.exitCode;
  } finally {
    for (const [signal, listener] of forward) process.off(signal, listener);
  }
}
