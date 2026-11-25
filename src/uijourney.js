// Keyboard steps and role-based assertions exercise a user-specified workflow.
// Only a completed browser interaction can yield a passing receipt.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { containsPath, physicalPath } from "./private_paths.js";
import { redactSecrets } from "./secrets.js";
import { launchChromium, resolvePlaywright, resolveTarget } from "./uivisual.js";

const KEYS = new Set([
  "Tab",
  "Shift+Tab",
  "Enter",
  "Space",
  "Escape",
  "ArrowDown",
  "ArrowUp",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
]);
export function validateJourney(spec) {
  if (!spec || !Array.isArray(spec.steps) || spec.steps.length < 1 || spec.steps.length > 32)
    throw new Error("A journey needs 1–32 expectation steps");
  const viewport = spec.viewport ?? { width: 1280, height: 800 };
  if (![viewport.width, viewport.height].every((v) => Number.isInteger(v) && v >= 200 && v <= 3000))
    throw new Error("Invalid journey viewport");
  const timeout = spec.timeoutMs ?? 5000;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 30000)
    throw new Error("Invalid per-step timeout");
  for (const s of spec.steps) {
    if (
      !s ||
      typeof s !== "object" ||
      (s.key !== undefined && !KEYS.has(s.key)) ||
      !["visible", "focused"].includes(s.expect) ||
      typeof s.role !== "string" ||
      !/^[a-z]{2,32}$/.test(s.role) ||
      typeof s.name !== "string" ||
      !s.name.trim() ||
      s.name.length > 256
    )
      throw new Error(
        "Each step needs an accessible role, exact name and visible/focused expectation",
      );
  }
  return { steps: spec.steps, viewport, timeout };
}
export async function runJourney(
  target,
  spec,
  { root = process.cwd(), remote = false, resolve = resolvePlaywright } = {},
) {
  const { steps, viewport, timeout } = validateJourney(spec);
  const targetInfo = resolveTarget(target, { cwd: root, remote });
  if (!targetInfo.ok)
    throw new Error("reason" in targetInfo ? targetInfo.reason : "Invalid journey target");
  root = realpathSync.native(root);
  const url = new URL(targetInfo.url);
  const directory = join(root, ".forge", "ui", "journeys", randomUUID());
  if (physicalPath(directory) !== directory)
    throw new Error("Journey evidence directory cannot be redirected");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const results = [];
  const write = (status, detail = "") => {
    const path = join(directory, "receipt.json");
    const body = {
      schemaVersion: 1,
      status,
      target: url.protocol === "file:" ? url.pathname : url.origin + url.pathname,
      viewport,
      steps: results,
      detail: redactSecrets(detail),
    };
    writeFileSync(path, JSON.stringify(body, null, 2), { mode: 0o600 });
    return { ...body, receipt: path };
  };
  let browser;
  try {
    const runtime = await resolve();
    if (!runtime) return write("incomplete", "Playwright is unavailable");
    browser = await launchChromium(runtime, root);
    const context = await browser.newContext({
      viewport,
      reducedMotion: "reduce",
      serviceWorkers: "block",
      acceptDownloads: false,
      locale: "en-US",
      timezoneId: "UTC",
    });
    const allowed = (raw) => {
      const next = new URL(raw);
      if (["data:", "blob:", "about:"].includes(next.protocol)) return true;
      if (url.protocol !== "file:") return next.origin === url.origin;
      return (
        next.protocol === "file:" &&
        containsPath(dirname(fileURLToPath(url)), physicalPath(fileURLToPath(next)))
      );
    };
    await context.route("**/*", (route) => {
      try {
        return allowed(route.request().url()) ? route.continue() : route.abort();
      } catch {
        return route.abort();
      }
    });
    if (context.routeWebSocket) await context.routeWebSocket("**/*", (ws) => ws.close());
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout });
    for (const [i, s] of steps.entries()) {
      if (s.key) await page.keyboard.press(s.key);
      let located;
      try {
        located = page.getByRole(s.role, { name: s.name, exact: true });
        await located.waitFor({ state: "visible", timeout });
        if (
          s.expect === "focused" &&
          !(await located.evaluate((el) => el === el.ownerDocument.activeElement))
        )
          throw new Error("Keyboard focus did not reach the expected control");
      } catch {
        results.push({
          step: i + 1,
          role: s.role,
          name: redactSecrets(s.name),
          key: s.key ?? null,
          expect: s.expect,
          matched: false,
        });
        return write("fail", "The expected accessible control or keyboard focus was not observed");
      }
      const filename = `step-${i + 1}.png`;
      const screenshot = await located.screenshot({
        path: join(directory, filename),
        animations: "disabled",
        timeout,
      });
      if (!screenshot.length || !statSync(join(directory, filename)).size)
        throw new Error("Missing screenshot evidence");
      const subtree =
        typeof located.ariaSnapshot === "function"
          ? redactSecrets((await located.ariaSnapshot()).slice(0, 4096))
          : null;
      results.push({
        step: i + 1,
        role: s.role,
        name: redactSecrets(s.name),
        key: s.key ?? null,
        expect: s.expect,
        matched: true,
        subtree,
        screenshot: filename,
        sha256: createHash("sha256").update(screenshot).digest("hex"),
      });
    }
    return write("pass");
  } catch (e) {
    return write("incomplete", String(e.message ?? e).slice(0, 400));
  } finally {
    try {
      await browser?.close();
    } catch {}
  }
}
