import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cloudService } from "../src/cloud_server.js";
import { sha } from "../src/cloud_snapshot.js";
import { launchChromium, resolvePlaywright } from "../src/uivisual.js";

test("hosted dashboard opens a scoped workspace, safely previews an artifact and clears the session", async (t) => {
  const pw = await resolvePlaywright();
  if (!pw) {
    t.skip("Install optional Playwright and Chromium to run native dashboard test");
    return;
  }
  const dataDir = mkdtempSync(join(realpathSync.native(tmpdir()), "forge-cloud-browser-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const env = { READ: randomBytes(32).toString("hex"), WRITE: randomBytes(32).toString("hex") };
  const server = cloudService(
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
});
