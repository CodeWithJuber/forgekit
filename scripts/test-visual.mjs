// Preserve the explicitly selected browser module while using the regular hermetic setup.
const runtime = process.env.FORGE_PLAYWRIGHT;
await import("../test/_setup.js");
if (runtime) process.env.FORGE_PLAYWRIGHT = runtime;
const { resolvePlaywright } = await import("../src/uivisual.js");
if (!(await resolvePlaywright()))
  throw new Error("Set FORGE_PLAYWRIGHT to an installed Playwright module with Chromium available");
await import("../test/uivisual.test.js");
await import("../test/uijourney.test.js");
await import("../test/cloud_dashboard.test.js");
