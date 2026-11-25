// Encoding is a property of a deployment. A byte budget is useful when no encoder is known.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { outsideWorkspace } from "./private_paths.js";

const requireTool = createRequire(import.meta.url);
/** @typedef {{descriptor:{kind:string,name?:string,version?:string},label:string,count:(text:string)=>number}} ContextCounter */
/** @type {ContextCounter} */
export const byteCounter = {
  descriptor: { kind: "utf8-bytes" },
  label: "UTF-8 byte count (upper bound for byte-level tokenizers)",
  count: (text) => Buffer.byteLength(String(text), "utf8"),
};

/** The caller chooses the encoding. Only an installed, out-of-checkout package can supply code. */
export function contextCounter(name, root) {
  if (!name || name === "utf8-bytes") return byteCounter;
  if (typeof name !== "string" || !/^[a-z0-9_]{1,64}$/.test(name))
    throw new Error("Invalid tokenizer encoding name");
  let entry;
  try {
    entry = requireTool.resolve("js-tiktoken");
  } catch {
    throw new Error(
      "Exact counting needs js-tiktoken installed outside this checkout on the Node module search path",
    );
  }
  const file = outsideWorkspace(
    root,
    entry,
    "Use a trusted js-tiktoken installation outside the checkout",
  );
  const metadata = JSON.parse(readFileSync(join(dirname(file), "..", "package.json"), "utf8"));
  if (metadata.name !== "js-tiktoken" || typeof metadata.version !== "string")
    throw new Error("Unknown tokenizer package");
  const encoder = requireTool(file).getEncoding(name);
  return {
    descriptor: { kind: "js-tiktoken", name, version: metadata.version },
    label: `${name} ordinary-text tokens (js-tiktoken ${metadata.version})`,
    count: (text) => encoder.encode(text, [], []).length,
  };
}

/** Decode old manifests without applying their approximate counting policy to new work. */
export function packetCounter(context, counter = byteCounter) {
  const binding = context.tokenizer;
  if (!binding) return (s) => Math.ceil(String(s).length / 3.6);
  if (
    binding.kind !== counter.descriptor.kind ||
    binding.name !== counter.descriptor.name ||
    binding.version !== counter.descriptor.version
  )
    throw new Error("Context packet needs its original tokenizer and version");
  return counter.count;
}
