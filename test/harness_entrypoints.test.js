import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { harnessRouteFingerprint } from "../src/harness_router.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const exec = promisify(execFile);

test("published CLI composes actual routing, scoped write, verification and replay; host config drift is observable", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "harness-entry-"));
  const root = join(folder, "project");
  mkdirSync(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  const env = {
    ...process.env,
    FORGE_HOME: join(folder, "private"),
    FORGE_NO_HINT: "1",
    FORGE_NO_CATALOG_FETCH: "1",
    FORGE_EVIDENCE_WEB: "0",
  };
  const run = async (...args) =>
    JSON.parse(
      (await exec(process.execPath, [cli, "harness", ...args], { cwd: root, env })).stdout,
    );
  const created = await run("init", "--hosts", "kimi,codex");
  assert.equal(created.created.length, 5);
  assert.equal((await run("drift")).ok, true);
  const requests = [];
  const srv = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const message =
      requests.length === 1
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "write-1",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({
                    path: "ticket.txt",
                    content: "closed\n",
                    expectedSha256: null,
                  }),
                },
              },
            ],
          }
        : { role: "assistant", content: "Updated ticket.txt." };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 15, total_tokens: 115 },
      }),
    );
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => {
    srv.closeAllConnections();
    srv.close();
  });
  const route = {
    id: "local",
    baseUrl: `http://127.0.0.1:${srv.address().port}/v1`,
    model: "harness-smoke",
    inputUsdPerMillion: 0,
    outputUsdPerMillion: 0,
    maxOutputTokens: 512,
  };
  writeFileSync(join(root, "harness/routing.yaml"), JSON.stringify({ routes: [route] }));
  env.FORGE_HARNESS_TRUSTED_ROUTES = harnessRouteFingerprint(route);
  await assert.rejects(run("status"), /forge harness trust/);
  await run("trust");
  const task = "Close the sample ticket",
    criterion = "ticket.txt contains closed and a newline",
    id = "ticket-smoke";
  const spec = join(folder, "fixture-assertions.json");
  writeFileSync(
    spec,
    JSON.stringify({
      mode: "assertions",
      task,
      runId: id,
      acceptance: [criterion],
      assertions: [{ criterion: 0, path: "ticket.txt", textEquals: "closed\n" }],
    }),
  );
  const saved = await run("run", task, "--id", id, "--accept", criterion, "--verifier", spec);
  assert.equal(saved.status, "done");
  assert.equal(saved.evidence.ok, true);
  assert.equal(requests.length, 2);
  assert.equal(readFileSync(join(root, "ticket.txt"), "utf8"), "closed\n");
  assert.ok((await run("replay", id)).events.some((e) => e.type === "tool.executed"));
  assert.equal(
    (await run("run", task, "--id", id, "--accept", criterion, "--verifier", spec)).status,
    "done",
  );
  assert.equal(requests.length, 2);
  const codex = join(root, ".codex/hooks.json");
  writeFileSync(codex, "{}");
  await assert.rejects(run("drift"), (e) =>
    JSON.parse(e.stdout).failures.some((row) => row.host === "codex"),
  );
});
