# Verify a keyboard workflow in a browser

Use a journey for a user action with an observable outcome, alongside the existing visual-style and general interaction checks. Describe the accessible role and exact name expected after each keyboard action.

```json
{
  "viewport": {"width": 390, "height": 844},
  "steps": [
    {"key":"Tab","role":"button","name":"Show order","expect":"focused"},
    {"key":"Enter","role":"heading","name":"Order ready","expect":"visible"}
  ]
}
```

Run `forge uicheck journey http://localhost:3000/orders --spec journey.json --json`. Point `FORGE_PLAYWRIGHT` at an installed Playwright module if your runtime is outside the package. Specify a trusted absolute system Chromium executable through `CHROME_BIN` when the Playwright-managed browser is unavailable. Desktop journeys default to 1280 × 800. Supply your supported mobile dimensions to verify that layout.

Each successful step records the expected role/name, the key, a target screenshot and its SHA-256 digest under `.forge/ui/journeys/`. The receipt also includes the observed accessibility subtree where the browser supports it. A missing expected control or wrong focused element fails the journey. An unavailable browser, failed navigation or missing screenshot produces an incomplete result. Both outcomes return a nonzero CLI status. Re-read a saved screenshot alongside its receipt when a UI review needs visual confirmation.

The browser uses an isolated context, reduced motion and same-origin requests. Use `--remote` to authorize a remote start URL. Choose a disposable test account and fixture for interactions that submit forms. Re-run with a changed expected role or name as a negative control. The journey verifies this workflow, viewport and browser. Include screen-reader users and other assistive technologies when evaluating accessibility across a product.

Run `npm run test:visual` with the optional runtime configured to exercise the live browser gate and keyboard journey tests.

For the developer dashboard, run `node scripts/dashboard-preview.mjs --check` from a checkout. This checks desktop and mobile views, the provider model filters, verified runs and an exported offline report. Managed browsers that block file URLs can use `--check --report-from-memory`. That mode loads the exported HTML bytes into a blank document with network access disabled.
