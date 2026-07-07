import assert from "node:assert/strict";
import { test } from "node:test";
import { collect, render } from "../scripts/build-pages.mjs";

test("pages renderer uses repo data and accessible landmarks", async () => {
  const data = await collect({ live: false });
  const html = render(data);
  assert.match(html, /<main id="top">/);
  assert.match(html, /aria-label="Primary"/);
  assert.match(html, /Data Sources/);
  assert.match(html, new RegExp(`v${data.version}`));
  assert.doesNotMatch(html, /lorem ipsum/i);
});

test("pages optional integration can validate live GitHub data", async (t) => {
  if (process.env.RUN_INTEGRATION !== "1") {
    t.skip("set RUN_INTEGRATION=1 to hit GitHub API");
    return;
  }
  const data = await collect({ live: true });
  assert.equal(typeof data.github?.stars, "number");
});
