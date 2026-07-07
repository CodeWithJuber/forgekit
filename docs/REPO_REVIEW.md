# Repository review notes

Date: 2026-07-07

## What is aligned

- Runtime dependency policy is consistent: `package.json` has no production dependencies and the docs describe a zero-runtime-dependency Node CLI.
- Core user docs are present: README, onboarding, architecture, guide, changelog, governance, support, security, releasing, and accessibility files exist.
- Benchmark claims in the README point readers to `reports/benchmarks.md`, which is the right direction for avoiding stale marketing numbers.

## Outdated or misalignment risks to monitor

- README benchmark excerpts are hand-copied from `reports/benchmarks.md`; rerun `npm run bench` before changing release claims.
- The GitHub `homepage` field still points at the README. If GitLab Pages becomes the primary marketing surface, update `package.json` after the Pages URL is known.
- `CHANGELOG.md` contains same-day `0.5.0` and `0.6.0` releases. That is valid, but release notes should stay explicit about sequencing to avoid reader confusion.
- Generated assets such as `public/index.html` should be regenerated with `npm run pages:build` whenever package metadata, benchmark summaries, or changelog content changes.

## Suggestions

- Add a CI job that runs `npm run pages:build` and fails if `public/index.html` is stale compared with committed sources.
- Consider publishing the GitLab Pages URL in `package.json.homepage` and the README once the project namespace is final.
- Add a small screenshot or preview image for the landing page after the first GitLab Pages deployment.
- Keep live public counters optional (`BUILD_PAGES_LIVE=1`) so forks and offline CI remain deterministic and rate-limit friendly.
