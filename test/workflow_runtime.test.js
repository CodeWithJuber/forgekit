import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { harnessRouteFingerprint } from "../src/harness_router.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const exec = promisify(execFile);

test("CLI delivery uses the real runtime, read-only roles, project receipts and explicit final approval", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "workflow-runtime-"));
  const root = join(dir, "project");
  mkdirSync(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "example.txt"), "original\n");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      scripts: { test: "node check.cjs" },
    }),
  );
  writeFileSync(
    join(root, "check.cjs"),
    'require("node:assert/strict").equal(require("node:fs").readFileSync("example.txt", "utf8"), "original\\n");\n',
  );
  const env = {
    ...process.env,
    FORGE_HOME: join(dir, "private"),
    FORGE_NO_HINT: "1",
    FORGE_NO_CATALOG_FETCH: "1",
    FORGE_EVIDENCE_WEB: "0",
  };
  const command = (...args) =>
    exec(process.execPath, [cli, ...args], { cwd: root, env, maxBuffer: 4 * 1024 * 1024 });
  const json = async (...args) => JSON.parse((await command(...args)).stdout);
  await json("harness", "init", "--hosts", "generic");
  const policy = JSON.parse(readFileSync(join(root, "harness/policy.yaml"), "utf8"));
  // Deliberately writable policies: workflow tool filtering, not the default
  // reviewer/researcher denial, must enforce the stage's read-only boundary.
  for (const name of ["researcher", "reviewer"]) {
    policy.profiles[name].stage = 3;
    policy.profiles[name].tools.write_file = "allowed";
  }
  policy.profiles.researcher.tools.read_file = "approval";
  writeFileSync(join(root, "harness/policy.yaml"), JSON.stringify(policy));
  const observed = [],
    deniedWrite = new Set();
  let requestedRead = false;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    const joined = input.messages.map((m) => String(m.content)).join("\n");
    const stage = /Workflow stage: ([a-z]+)\./.exec(joined)?.[1];
    assert.ok(stage, "runtime receives the stage-specific task");
    observed.push({ stage, tools: (input.tools ?? []).map((x) => x.function.name) });
    let message;
    if (stage === "requirement" && !requestedRead) {
      requestedRead = true;
      message = {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "approved-read",
            type: "function",
            function: { name: "read_file", arguments: JSON.stringify({ path: "example.txt" }) },
          },
        ],
      };
    } else if (stage === "requirement" && !deniedWrite.has(stage)) {
      deniedWrite.add(stage);
      message = {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "forbidden-write",
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({
                path: "example.txt",
                content: "mutated\n",
                expectedSha256: createHash("sha256").update("original\n").digest("hex"),
              }),
            },
          },
        ],
      };
    } else {
      message = {
        role: "assistant",
        content: JSON.stringify({
          summary: `${stage} result`,
          details:
            "The fixture retains example.txt and the existing test checks its exact content.",
          evidence: ["check.cjs asserts the expected content"],
          blockers: [],
          decision: stage === "knowledge" ? "skip" : "proceed",
        }),
      };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const route = {
    id: "local",
    model: "workflow-fixture",
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    inputUsdPerMillion: 0,
    outputUsdPerMillion: 0,
    maxOutputTokens: 1024,
  };
  writeFileSync(join(root, "harness/routing.yaml"), JSON.stringify({ routes: [route] }));
  env.FORGE_HARNESS_TRUSTED_ROUTES = harnessRouteFingerprint(route);
  await json("harness", "trust");
  // No report-only substitute: generate a real signed project-suite receipt.
  await command("verify", "--json");
  const created = await json(
    "workflow",
    "create",
    "Inspect and retain the example",
    "--size",
    "medium",
    "--accept",
    "example.txt remains original",
  );
  assert.equal(observed.length, 0);
  // Die after the workflow persists its run ID but before the harness exists.
  // Resumption must reclaim the dead writer and use the exact saved request.
  const workflowModule = new URL("../src/workflow.js", import.meta.url).href;
  await assert.rejects(
    exec(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {runWorkflow} from ${JSON.stringify(workflowModule)};
     await runWorkflow(process.cwd(), process.argv[1], async () => process.exit(13));`,
        created.id,
      ],
      { cwd: root, env },
    ),
    (error) => error.code === 13,
  );
  let paused;
  await assert.rejects(json("workflow", "resume", created.id), (error) => {
    paused = JSON.parse(error.stdout);
    return error.code === 1 && paused.status === "blocked";
  });
  const runId = paused.stages[0].attempts[0].runId;
  const saved = await json("harness", "show", runId);
  assert.equal(saved.request.workflowStage, "requirement");
  await json("harness", "approvals", "grant", saved.approval.id);
  const resumed = await json("harness", "resume", runId);
  assert.equal(
    resumed.evidence.scope,
    "workflow-report",
    "direct harness resume keeps the workflow verification contract",
  );
  let flow = await json("workflow", "resume", created.id);
  assert.equal(flow.status, "approval_pending");
  assert.equal(readFileSync(join(root, "example.txt"), "utf8"), "original\n");
  assert.equal(flow.stages[0].attempts[0].evidence.scope, "workflow-report");
  assert.ok(observed.every((x) => !x.tools.includes("write_file")));
  await assert.rejects(
    json("workflow", "approve", created.id, "--stage", "requirement", "--digest", "0".repeat(64)),
    /digest/,
  );
  await json(
    "workflow",
    "approve",
    created.id,
    "--stage",
    "requirement",
    "--digest",
    flow.stages[0].attempts[0].digest,
  );
  flow = await json("workflow", "run", created.id);
  assert.equal(flow.status, "approval_pending");
  for (const name of ["implement", "test"]) {
    const attempt = flow.stages.find((s) => s.name === name).attempts[0];
    assert.equal(attempt.evidence.scope, "project-suites");
    assert.match(attempt.evidence.output, /PASS/);
  }
  assert.ok(
    observed.filter((x) => x.stage === "implement").every((x) => x.tools.includes("write_file")),
  );
  assert.ok(
    observed.filter((x) => x.stage !== "implement").every((x) => !x.tools.includes("write_file")),
  );
  const runIds = flow.stages.map((s) => s.attempts[0].runId);
  assert.equal(new Set(runIds).size, 7);
  const final = flow.stages.at(-1).attempts[0];
  assert.equal(
    (await json("workflow", "approve", created.id, "--stage", "summary", "--digest", final.digest))
      .status,
    "done",
  );
  const count = observed.length;
  assert.equal((await json("workflow", "run", created.id)).status, "done");
  assert.equal(observed.length, count);
  assert.equal((await json("workflow", "status", created.id)).credit.project, "Tencent/LoopForge");
});
