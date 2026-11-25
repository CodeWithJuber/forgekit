import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { cloudService } from "../src/cloud_server.js";
import { sha } from "../src/cloud_snapshot.js";
import { launchChromium, resolvePlaywright } from "../src/uivisual.js";

async function checkDashboard(t, crlf = false) {
  const pw = await resolvePlaywright();
  if (!pw) {
    t.skip("Install optional Playwright and Chromium to run native dashboard test");
    return;
  }
  const dataDir = mkdtempSync(join(realpathSync.native(tmpdir()), "forge-cloud-browser-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const env = { READ: randomBytes(32).toString("hex"), WRITE: randomBytes(32).toString("hex") };
  let start = cloudService;
  if (crlf) {
    const checkout = join(dataDir, "checkout");
    cpSync(new URL("../src/", import.meta.url), join(checkout, "src"), { recursive: true });
    for (const name of ["brand.json", "package.json"])
      copyFileSync(new URL("../" + name, import.meta.url), join(checkout, name));
    const asset = join(checkout, "src", "cloud_dashboard.html");
    writeFileSync(asset, readFileSync(asset, "utf8").replace(/\r\n?|\n/g, "\r\n"));
    ({ cloudService: start } = await import(
      pathToFileURL(join(checkout, "src", "cloud_server.js")).href
    ));
  }
  const server = start(
    {
      dataDir,
      principals: [
        { tenant: "one", workspace: "demo", role: "reader", tokenEnv: "READ" },
        { tenant: "one", workspace: "demo", role: "writer", tokenEnv: "WRITE" },
      ],
    },
    env,
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve(undefined)));
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback test port");
  const origin = `http://127.0.0.1:${address.port}`;
  const path = "session.txt",
    bytes = Buffer.from("<em>Recorded text</em>");
  const upload = await fetch(`${origin}/v1/workspaces/demo/sync`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.WRITE}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      id: randomUUID(),
      parent: null,
      files: [
        {
          path,
          bytes: bytes.length,
          content: bytes.toString("base64"),
          kind: "text",
          redacted: false,
          sha256: sha(bytes),
        },
      ],
      removed: [],
    }),
  });
  assert.equal(upload.status, 200);
  const browser = await launchChromium(pw, dataDir);
  t.after(() => browser.close());
  const page = await browser.newPage();
  const violations = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && /content security policy/i.test(msg.text()))
      violations.push(msg.text());
  });
  await page.goto(origin);
  await page.getByLabel("Workspace", { exact: true }).fill("demo");
  await page.getByLabel("Access token").fill(env.READ);
  await page.getByRole("button", { name: "Open workspace" }).click();
  await page.getByRole("button", { name: path }).click();
  await page.getByRole("link", { name: "Download artifact" }).waitFor();
  assert.equal(await page.locator("#preview").textContent(), bytes.toString());
  assert.equal(await page.locator("#preview em").count(), 0);
  await page.getByRole("button", { name: /1 updated/ }).click();
  await page.waitForFunction(() =>
    document.getElementById("preview").textContent.includes('"updated"'),
  );
  await page.getByLabel("Filter by path").fill("another file");
  assert.equal(await page.getByRole("button", { name: path }).count(), 0);
  await page.getByRole("button", { name: "Clear session" }).click();
  assert.equal(await page.getByLabel("Access token").inputValue(), "");
  assert.equal(await page.getByRole("heading", { name: "Workspace files" }).isVisible(), false);
  assert.deepEqual(violations, []);
}

test("hosted dashboard opens a scoped workspace, safely previews an artifact and clears the session", (t) =>
  checkDashboard(t));
test("Chromium authenticates and previews dashboard artifacts from a CRLF checkout", (t) =>
  checkDashboard(t, true));
