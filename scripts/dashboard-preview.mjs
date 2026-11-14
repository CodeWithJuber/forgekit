// Capture the real local dashboard with a disposable workspace, deterministic runs
// and no provider credentials. --check exercises the same browser flow without writing images.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultHarnessRouting, harnessRouteFingerprint } from "../src/harness_router.js";
import { ensureArchify } from "./diagrams.mjs";

const script = fileURLToPath(import.meta.url);
const root = dirname(dirname(script));
const cli = join(root, "src/cli.js");
const date = Date.parse("2026-11-12T14:25:00Z");
const clock = `const OriginalDate = Date;
  globalThis.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [Date.now()])); }
    static now() { return globalThis.fixtureTime; }
  };`;

// The screenshot represents a sample project; all rows are produced by the real
// run loop. The deterministic model checks a local policy file, including a
// deliberate failed assertion and a write that requires explicit approval.
async function seed() {
  const { runHarness } = await import("../src/harness_loop.js");
  const { defaultHarnessPolicy } = await import("../src/harness_policy.js");
  const { createHarnessTools } = await import("../src/harness_tools.js");
  const { mintClaim } = await import("../src/ledger.js");
  const { putClaim, repoLedger } = await import("../src/ledger_store.js");
  const { record } = await import("../src/metrics.js");
  const project = process.cwd();
  const policyFile = join(project, "delivery.json");
  writeFileSync(policyFile, '{"attempts":3,"timeout":10,"region":"local"}\n');
  const cases = [
    ["delivery-timeout", "Check the delivery timeout", "timeout", 10, "done"],
    ["delivery-region", "Verify the delivery region", "region", "local", "done"],
    ["delivery-retries", "Check the retry limit", "attempts", 2, "verification_failed"],
    ["delivery-policy", "Update the delivery policy", "attempts", 3, "approval_pending"],
  ];
  for (const [i, [id, task, key, expected, status]] of cases.entries()) {
    globalThis.fixtureTime = date - (cases.length - i) * 5 * 60000;
    const policy = defaultHarnessPolicy();
    policy.profiles.coder.tools.write_file = "approval";
    let step = 0;
    const result = await runHarness({
      root: project,
      request: { id, task, acceptance: [`Check delivery field ${key}`], profile: "coder" },
      policy,
      tools: createHarnessTools(),
      budget: { repairs: 0 },
      model: async () => {
        if (step++ === 0) {
          const write = status === "approval_pending";
          return {
            toolCalls: [
              {
                name: write ? "write_file" : "read_file",
                args: write
                  ? {
                      path: "delivery-notes.md",
                      expectedSha256: null,
                      content: "Use the verified delivery policy.",
                    }
                  : { path: "delivery.json" },
              },
            ],
            tokens: 10,
            costUsd: 0,
          };
        }
        return { finalText: "Check the repository's delivery policy.", tokens: 10, costUsd: 0 };
      },
      verify: () => {
        const actual = JSON.parse(readFileSync(policyFile, "utf8"))[key];
        return {
          ok: actual === expected,
          command: "check delivery.json",
          output: `${key}: expected ${expected}, found ${actual}`,
        };
      },
    });
    assert.equal(result.status, status, result.reason);
  }
  const claim = mintClaim({
    kind: "fact",
    body: { name: "delivery-region", text: "Orders are routed by delivery region." },
    provenance: { author: "fixture" },
    t: Math.floor(date / 86400000),
  });
  assert.ok(claim.ok, "Fixture claim is valid");
  putClaim(repoLedger(project), claim.claim);
  record(project, { t: date - 60000, stage: "gate", outcome: "pass" });
}

function exerciseServer(project, env) {
  const child = spawn(process.execPath, [cli, "dash", "--port", "0"], {
    cwd: project,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Dashboard did not start: ${output}`)),
      15000,
    );
    child.once("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Dashboard exited ${code}: ${output}`));
    });
    child.stderr.on("data", (buf) => {
      output += buf;
    });
    child.stdout.on("data", (buf) => {
      output += buf;
      const url = /http:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0];
      if (url) {
        clearTimeout(timeout);
        resolve(url);
      }
    });
  });
  return { child, ready };
}

async function capture(check) {
  const { dir } = ensureArchify(root);
  const driver = await import(pathToFileURL(join(dir, "archify/bin/visual-check.mjs")).href);
  const chrome = process.env.ARCHIFY_CHROME || driver.findChrome();
  assert.ok(chrome, "Set ARCHIFY_CHROME to an installed Chromium executable.");
  const work = mkdtempSync(join(tmpdir(), "forge-dash-preview-"));
  const project = join(work, "parcel-service");
  const home = join(work, "home");
  const preload = join(work, "clock.cjs");
  mkdirSync(project);
  mkdirSync(home);
  writeFileSync(preload, `globalThis.fixtureTime=${date};\n${clock}`);
  // Never inherit operator configuration, credentials, model settings or real project data.
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    FORGE_HOME: join(home, "state"),
    GIT_CONFIG_NOSYSTEM: "1",
    FORGE_EVIDENCE_WEB: "0",
    FORGE_NO_HINT: "1",
    NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
    TZ: "UTC",
    LANG: "C.UTF-8",
  };
  const command = (program, args) =>
    execFileSync(program, args, { cwd: project, env, encoding: "utf8" });
  let replies = 0;
  const provider = createServer((req, res) => {
    if (req.url !== "/v1/chat/completions" || req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    req.resume();
    replies++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: { role: "assistant", content: "Verified the delivery fixture." },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 8 },
      }),
    );
  });
  let live;
  let browser;
  try {
    await new Promise((resolve, reject) => {
      provider.once("error", reject);
      provider.listen(0, "127.0.0.1", () => resolve(true));
    });
    const routing = defaultHarnessRouting();
    const address = provider.address();
    assert.ok(address && typeof address === "object");
    routing.routes[0].baseUrl = `http://127.0.0.1:${address.port}/v1`;
    env.FORGE_HARNESS_TRUSTED_ROUTES = harnessRouteFingerprint(routing.routes[0]);
    command("git", ["init", "-q"]);
    live = exerciseServer(project, env);
    const url = await live.ready;
    browser = new driver.ChromeVisualBrowser(chrome);
    const sid = await browser.sessionPromise;
    const send = (method, params = {}) => browser.cdp.send(method, params, sid, 30000);
    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails)
        throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result?.value;
    };
    const wait = async (test, label) => {
      for (let i = 0; i < 100; i++) {
        if (await evaluate(test)) return;
        await delay(75);
      }
      throw Error(
        `Dashboard did not show ${label}: ${(await evaluate("document.body.innerText")).slice(0, 800)}`,
      );
    };
    const view = (width, height) =>
      send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
    const click = (selector) =>
      evaluate(
        `(() => {const e=document.querySelector(${JSON.stringify(selector)}); if(!e || !e.getClientRects().length)throw Error("Hidden or absent: "+${JSON.stringify(selector)}); e.click();})()`,
      );
    await view(1440, 960);
    await send("Emulation.setTimezoneOverride", { timezoneId: "UTC" });
    await send("Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-reduced-motion", value: "reduce" },
        { name: "prefers-color-scheme", value: "light" },
      ],
    });
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: `globalThis.fixtureTime=${date};${clock}
      window.__errors=[]; window.addEventListener('error',e=>__errors.push(e.message));
      window.addEventListener('unhandledrejection',e=>__errors.push(String(e.reason)));
      const original=console.error; console.error=(...args)=>{__errors.push(args.join(' '));original(...args);};`,
    });
    await send("Page.navigate", { url });
    await wait(
      "document.querySelector('#page-title') && /no runs yet/i.test(document.body.innerText)",
      "first-run overview",
    );
    await click('a[href="#hosts"]');
    await wait(
      "document.querySelector('#host-list')?.innerText.includes('Claude')",
      "coding hosts",
    );
    assert.match(await evaluate("document.querySelector('#host-list').innerText"), /Kimi/);
    await click('a[href="#overview"]');
    command(process.execPath, [
      cli,
      "harness",
      "init",
      "--hosts",
      "claude,codex,kimi",
      "--supervised",
    ]);
    writeFileSync(join(project, "harness/routing.yaml"), JSON.stringify(routing));
    command(process.execPath, [cli, "harness", "trust"]);
    command(process.execPath, [script, "--seed"]);
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({ name: "parcel-service", scripts: { test: "node --test policy.test.cjs" } }),
    );
    writeFileSync(
      join(project, "policy.test.cjs"),
      "require('node:assert/strict').equal(require('./delivery.json').attempts,3);",
    );
    command(process.execPath, [cli, "verify", "--json"]);
    await click("#refresh");
    await wait(
      "document.querySelector('#recent-runs')?.innerText.includes('Update the delivery policy')",
      "seeded overview after refresh",
    );
    assert.equal(await evaluate("document.activeElement.id"), "page-title");
    // Capture the initial populated page, without the keyboard focus left over
    // from the preceding navigation check.
    await send("Page.navigate", { url });
    await wait(
      "document.querySelector('#recent-runs')?.innerText.includes('Update the delivery policy')",
      "populated first load",
    );
    await evaluate("document.fonts.ready.then(()=>true)");
    const image = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    await click('#recent-runs [data-open-run="delivery-retries"]');
    await wait(
      "document.querySelector('#run-list details[open]')?.dataset.id === 'delivery-retries'",
      "the selected run's details",
    );
    await click("#new-run");
    await wait(
      "!!document.querySelector('#new-run-form')?.getClientRects().length",
      "new run form",
    );
    assert.ok(
      await evaluate("!!document.querySelector('#run-task')?.labels?.length"),
      "task needs a visible label",
    );
    // Deliberately submit an empty task: the form must not invoke a provider.
    await click("#submit-run");
    assert.equal(await evaluate("document.querySelector('#run-task').validity.valueMissing"), true);
    await evaluate(
      "document.querySelector('#run-task').value='Verify the parcel service tests';document.querySelector('#run-acceptance').value='The declared suite passes'",
    );
    await click("#submit-run");
    await wait(
      "document.querySelector('#launch-feedback')?.innerText.includes('Copy ID')",
      "browser-submitted run",
    );
    await wait(
      "(async()=>{const h=await fetch('/api/harness').then(r=>r.json());return h.runs.some(r=>r.task==='Verify the parcel service tests' && r.status==='done');})()",
      "independently verified browser run",
    );
    assert.ok(replies > 0, "The browser run must use the controlled loopback model.");
    await click('a[href="#memory"]');
    await wait("!!document.querySelector('#mem-q')?.getClientRects().length", "memory search");
    await wait(
      "document.querySelector('#memory-out')?.innerText.includes('Orders are routed by delivery region.')",
      "unfiltered fixture claim",
    );
    await evaluate(
      "const q=document.querySelector('#mem-q'); q.value='no-matching-fixture';q.dispatchEvent(new Event('input',{bubbles:true}))",
    );
    await wait(
      "!document.querySelector('#memory-out').innerText.includes('Orders are routed by delivery region.')",
      "memory search filtering",
    );
    assert.deepEqual(await evaluate("window.__errors"), []);
    await view(390, 844);
    await send("Page.navigate", { url });
    await wait(
      "document.querySelector('#recent-runs')?.innerText.includes('Update the delivery policy')",
      "mobile overview",
    );
    assert.ok(
      await evaluate("document.documentElement.scrollWidth <= innerWidth"),
      "mobile layout overflows",
    );
    await click("#menu");
    await click('a[href="#hosts"]');
    await wait(
      "document.querySelector('#host-list')?.innerText.includes('Claude')",
      "mobile host navigation",
    );
    assert.ok(
      await evaluate("document.documentElement.scrollWidth <= innerWidth"),
      "mobile host list overflows",
    );
    assert.deepEqual(await evaluate("window.__errors"), []);
    const report = join(work, "report.html");
    command(process.execPath, [cli, "report", "--out", report]);
    await send("Network.enable");
    await send("Network.emulateNetworkConditions", {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
    });
    await send("Page.navigate", { url: pathToFileURL(report).href });
    await wait("document.body?.innerText.includes('parcel-service')", "offline project report");
    assert.ok(
      await evaluate("document.body.innerText.includes('Orders are routed by delivery region.')"),
    );
    if (!check) {
      const bytes = Buffer.from(image.data, "base64");
      for (const p of ["docs/assets/dashboard.png", "mintlify/images/dashboard.png"])
        writeFileSync(join(root, p), bytes);
    }
    console.log(
      "Dashboard checks passed: empty and populated live projects, runs, form, hosts, memory filter, mobile navigation, offline report.",
    );
  } finally {
    try {
      await browser?.close();
    } finally {
      provider.closeAllConnections();
      provider.close();
      live?.child.kill();
      rmSync(work, { recursive: true, force: true });
    }
  }
}

if (process.argv[2] === "--seed") await seed();
else await capture(process.argv.includes("--check"));
