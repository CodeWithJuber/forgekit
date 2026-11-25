// MCP can propose, but has no promotion or rejection capability. Proposals never sync.
import { randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { brainStore, remember } from "./brain.js";
import { factConflicts } from "./ledger_read.js";
import { privateMemoryDir } from "./private_memory.js";
import { ledgerForStore, readFact } from "./recall.js";
import { hasSecret } from "./secrets.js";
import { contentHash, slug } from "./util.js";

function candidateId(name, body) {
  return contentHash(JSON.stringify(["agent:mcp", name, body]));
}

function loadCandidate(dir, id) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid proposal ID");
  const file = join(dir, `${id}.json`);
  if (!existsSync(file)) throw new Error("Unknown proposal ID");
  const p = JSON.parse(readFileSync(file, "utf8"));
  if (p.id !== id || candidateId(p.name, p.body) !== id) throw new Error("Damaged proposal");
  return p;
}

export function proposeMemory(root, name, body) {
  if (typeof name !== "string" || !name.trim() || typeof body !== "string" || !body.trim())
    return { ok: false, reason: "A proposal needs a name and a body." };
  if (hasSecret(`${name}\n${body}`)) return { ok: false, reason: "Secret-shaped content refused." };
  const dir = privateMemoryDir(root, "proposals");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  name = name.trim();
  body = body.trim();
  const id = candidateId(name, body);
  const ready = join(dir, `${id}.json`);
  const temp = join(dir, `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify({ id, name, body, author: "agent:mcp" }), {
      mode: 0o600,
      flag: "wx",
    });
    try {
      linkSync(temp, ready);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      loadCandidate(dir, id);
    }
  } finally {
    rmSync(temp, { force: true });
  }
  return { ok: true, id };
}

export function listProposals(root) {
  const dir = privateMemoryDir(root, "proposals");
  if (!existsSync(dir)) return [];
  const proposals = [];
  for (const file of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!file.isFile() || !/^[a-f0-9]{64}\.json$/.test(file.name)) continue;
    try {
      proposals.push(loadCandidate(dir, file.name.slice(0, -5)));
    } catch {
      // A damaged or concurrently reviewed proposal leaves its siblings available.
    }
  }
  return proposals;
}

export function reviewProposal(root, id, approve) {
  const dir = privateMemoryDir(root, "proposals");
  const p = loadCandidate(dir, id);
  if (approve) {
    const store = brainStore(root);
    const previous = readFact(store, slug(p.name) || "fact");
    if (
      factConflicts(ledgerForStore(store)).has(slug(p.name) || "fact") ||
      (previous && (previous.name !== p.name || previous.text !== p.body))
    )
      throw new Error(
        "Conflict with an existing fact. Inspect both values and resolve explicitly with forge remember, then reject the proposal.",
      );
    const result = remember(store, p.name, p.body, { replace: false });
    if (!result.ok) throw new Error(result.reason);
  }
  rmSync(join(dir, `${id}.json`));
  return { id, status: approve ? "approved" : "rejected" };
}
