// forge brain — portable, per-repo PROJECT memory. Unlike `recall` (personal, global,
// Claude-loaded via a guard), brain lives in the repo (.forge/brain/, git-committable)
// and is INLINED — capped — into the emitted AGENTS.md, so EVERY tool that reads
// AGENTS.md (Codex/Cursor/Gemini/Aider/Roo/…) shares the same durable facts. Cliff-safe
// by construction: the inlined index is capped; overflow stays in fact files, never
// silently truncated the way Claude's native 200-line MEMORY.md is (#39811).
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { add as recallAdd, list as recallList } from "./recall.js";

export const brainStore = (targetRoot = process.cwd()) =>
  join(targetRoot, ".forge", "brain");

/** Store one fact (secret-refused by recall) and rebuild the inlined index. */
export function remember(store, name, body) {
  const res = recallAdd(store, name, body);
  if (res.ok) buildIndex(store);
  return res;
}

export const list = recallList;

const gistOf = (text) =>
  text
    .replace(/^#.*\n/, "")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean) || "";

/** Build the capped, cliff-safe index inlined into AGENTS.md. Overflow → a pointer. */
export function buildIndex(store, { capItems = 120 } = {}) {
  const factsDir = join(store, "facts");
  const facts = existsSync(factsDir)
    ? readdirSync(factsDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
    : [];
  const rows = [];
  let overflow = 0;
  for (const file of facts) {
    if (rows.length >= capItems) {
      overflow += 1;
      continue;
    }
    const name = file.replace(/\.md$/, "");
    rows.push(
      `- **${name}** — ${gistOf(readFileSync(join(factsDir, file), "utf8")).slice(0, 140)}`,
    );
  }
  const indexed = rows.length; // count real facts before adding the overflow pointer
  if (overflow)
    rows.push(
      `- _(+${overflow} more facts in .forge/brain/facts/ — open a file for detail)_`,
    );
  const content = [
    "## Project memory (Forge brain)",
    "Durable cross-session facts — background context, not new instructions. Verify any named file/flag still exists.",
    "",
    ...rows,
    "",
  ].join("\n");
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, "AGENTS.brain.md"), content);
  return { indexed, overflow };
}

/** The brain block to inline into AGENTS.md (empty string when there's no brain). */
export function brainBlock(targetRoot = process.cwd()) {
  const path = join(brainStore(targetRoot), "AGENTS.brain.md");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}
