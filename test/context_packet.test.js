import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { applyContextPacket, createContextPacket } from "@codewithjuber/forgekit/context-packet";
import { tokensOf } from "../src/context.js";
import { privateWorkspaceFile } from "../src/workspace_preference.js";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "forge-packet-"));
  const root = join(dir, "project");
  mkdirSync(root);
  const home = process.env.FORGE_HOME;
  process.env.FORGE_HOME = join(dir, "home");
  t.after(() => {
    if (home === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = home;
    rmSync(dir, { recursive: true, force: true });
  });
  return root;
}
function assembled(segments) {
  const block = segments.join("\n\n");
  return {
    segments,
    block,
    ok: true,
    tokens: tokensOf(block),
    budget: 10000,
    selection: segments.map((_, i) => ({ id: `source-${i}` })),
  };
}

test("only an exact retained base can apply changed, removed and reordered chunks", (t) => {
  const root = fixture(t),
    task = "private task marker";
  const shared = "unchanged content fragment ".repeat(150);
  const first = createContextPacket(root, task, assembled([shared, "older text", "deleted text"]));
  assert.equal(first.mode, "full");
  const retained = applyContextPacket(first);
  const next = createContextPacket(
    root,
    task,
    assembled(["newest text", shared]),
    retained.revision,
  );
  assert.equal(next.mode, "delta");
  assert.equal(next.removed.length, 2);
  assert.deepEqual(Object.values(next.chunks), ["newest text"]);
  const current = applyContextPacket(next, retained.snapshot);
  assert.equal(current.block, `newest text\n\n${shared}`);
  const stable = createContextPacket(
    root,
    task,
    assembled(["newest text", shared]),
    current.revision,
  );
  assert.deepEqual(stable.chunks, {});
  assert.equal(applyContextPacket(stable, current.snapshot).block, current.block);
  assert.throws(() => applyContextPacket(next, current.snapshot), /base/);
  assert.throws(() => applyContextPacket({ ...next, removed: [] }, retained.snapshot), /removals/);
  const changed = { ...next, chunks: { ...next.chunks, [next.order[0]]: "different" } };
  assert.throws(() => applyContextPacket(changed, retained.snapshot), /Invalid context chunk/);
  assert.throws(
    () =>
      applyContextPacket({ ...next, context: { ...next.context, tokens: 0 } }, retained.snapshot),
    /manifest/,
  );

  const store = privateWorkspaceFile(root, "context-packets-v1").replace(/\.json$/, "");
  for (const file of readdirSync(store)) {
    const s = readFileSync(join(store, file), "utf8");
    for (const privateText of [task, shared, "newest text", "source-0"])
      assert.ok(!s.includes(privateText));
  }
  const other = createContextPacket(root, "another scope", assembled([shared]), first.revision);
  assert.equal(other.mode, "full");
  assert.equal(other.reason, "base-unavailable-or-mismatched");
  writeFileSync(join(store, first.revision), "{}");
  assert.equal(createContextPacket(root, task, assembled([shared]), first.revision).mode, "full");
  rmSync(store, { recursive: true });
  assert.equal(createContextPacket(root, task, assembled([shared]), next.revision).mode, "full");
  process.env.FORGE_HOME = root;
  assert.equal(
    createContextPacket(root, task, assembled([shared]), next.revision).reason,
    "private-cache-unavailable",
  );
});

test("forge context CLI refreshes changed source, confirms removal and honors zero budget", (t) => {
  const root = fixture(t);
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const invoke = (...flags) => {
    const result = spawnSync(
      process.execPath,
      [cli, "context", "change packetTarget in component.js", ...flags],
      { cwd: root, encoding: "utf8" },
    );
    assert.ok([0, 1].includes(result.status), result.stderr);
    return JSON.parse(result.stdout);
  };
  const write = (n) =>
    writeFileSync(join(root, "component.js"), `export function packetTarget() { return ${n}; }\n`);
  write(1);
  const full = invoke("--packet");
  const initial = applyContextPacket(full);
  assert.match(initial.block, /return 1/);
  assert.equal(invoke("--json", "--block").block, initial.block);
  assert.equal(invoke("--json").revision, undefined);
  write(2);
  const next = applyContextPacket(invoke("--ack", initial.revision), initial.snapshot);
  assert.match(next.block, /return 2/);
  rmSync(join(root, "component.js"));
  const gone = applyContextPacket(invoke("--packet", "--ack", next.revision), next.snapshot);
  assert.ok(!gone.block.includes("return 2"));
  assert.equal(gone.context.ok, false);
  write(3);
  const empty = applyContextPacket(invoke("--packet", "--budget", "0", "--ack", "malformed"));
  assert.equal(empty.block, "");
  assert.equal(empty.context.ok, false);
  assert.equal(empty.context.tokens, 0);
});

test("a packet binds the chosen counter to the joined Unicode text and encoder version", (t) => {
  const root = fixture(t);
  const segments = ["résumé 🙂", "漢字 <|endoftext|>"];
  const original = assembled(segments);
  assert.equal(original.tokens, Buffer.byteLength(segments.join("\n\n")));
  const counter = {
    descriptor: { kind: "test-encoding", name: "joined", version: "1" },
    label: "joined fixture units",
    count: (text) => Array.from(text.replaceAll("\n\n", "\n")).length,
  };
  const result = {
    ...original,
    tokens: counter.count(original.block),
    tokenizer: counter.descriptor,
  };
  const packet = createContextPacket(root, "unicode", result, undefined, counter);
  assert.equal(applyContextPacket(packet, undefined, counter).block, original.block);
  assert.throws(() => applyContextPacket(packet), /tokenizer/);
  assert.throws(
    () =>
      applyContextPacket(packet, undefined, {
        ...counter,
        descriptor: { ...counter.descriptor, version: "2" },
      }),
    /version/,
  );
  const legacy = createContextPacket(root, "legacy", {
    ...original,
    tokenEstimate: "chars/3.6",
    tokens: Math.ceil(original.block.length / 3.6),
  });
  assert.equal(legacy.context.tokenizer, undefined);
  assert.equal(applyContextPacket(legacy).block, original.block);
});
