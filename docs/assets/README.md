# Brand and image assets

| File | Used by | How it is made |
| --- | --- | --- |
| `favicon.svg`, `apple-touch-icon.png` | Every page of the Pages site; the Pages build serves them from the site root. | Vector mark |
| `hero-light.svg`, `hero-dark.svg` | README overview for each GitHub theme. | Host names come from the native adapter registry. Both variants use one SVG template and the colors in `brand.json`. |
| `demo.gif` | The README and the Mintlify supervised-runs guide. | Live CLI capture. The renderer also writes `mintlify/images/supervised-setup.gif`. |
| `.github/assets/forgekit-{verify,precommit,memory}.gif` | README examples of a failing suite, a staged test credential and recall across two CLI invocations. | Live CLI capture |
| `mintlify/images/{adversarial-doctor,cost-governance}.gif` | Mintlify solution guides. | Live CLI capture |
| `mintlify/images/og-image.png`, `.github/assets/social-preview.png` | Mintlify share card and the card available for upload in GitHub social-preview settings. | `python3 scripts/make-social-images.py` |
| `dashboard.png`, `mintlify/images/dashboard.png` | Recorded dashboard with a disposable project fixture. | `node scripts/dashboard-preview.mjs` |
| `og.svg` | The source of the social card: wordmark, headline and subline over `og-background.webp`. | Edited by hand |
| `og-background.webp` | The card's art: a girih lattice and khatam star on the right, leaving the left side empty for type. | Generated art, 2400×1260 |
| `og.jpg` | `og:image` and `twitter:image` on the landing and status pages. | `node scripts/og-card.mjs`. Never edit it directly. |

## Automatic refresh

On every push to `master`, the docs workflow compares each asset group's inputs and output hashes with `media-receipts.json`. Changes to CLI behavior recapture terminal demos. Dashboard source or fixture changes rebuild the dashboard preview. Theme, copy and rendering changes rebuild the applicable artwork. Linked copies are checked too. Input changes remain pending across pushes until the regenerated files reach the default branch.

The workflow checks the rendered output, publishes its generated changes on `docs/auto-update` and requests a normal SHA-matched merge. Repository status checks and review requirements still apply. Configure **Allow auto-merge** and grant Actions permission to create pull requests. If the default Actions token creates a proposal that needs workflow approval, approve it in the PR. For unattended PR checks and downstream deployment events, set the optional `FORGE_DOCS_TOKEN` Actions secret to a dedicated bot credential authorized for repository contents and pull requests. A bot without those permissions leaves a visible workflow error. [GitHub Actions tokens](https://docs.github.com/en/actions/concepts/security/github_token)

The Actions job summary also lists handwritten guide references affected by a change, including runs that produce no generated diff. The generator uses measured CLI output, tracked templates and published assets. Authors revise prose where an API or behavior change needs a new explanation.

Reproduce the Linux renderer with Node 22.14.0, Python 3.12.10 and Git. Run in Bash on x86-64 Linux:

```sh
tools_dir=$(mktemp -d)
scripts/docs-media/setup.sh "$tools_dir"
set -a
. "$tools_dir/env"
set +a
node scripts/docs-media.mjs plan
node scripts/docs-media.mjs build
node scripts/docs-media.mjs check
```

The tool setup verifies the Chromium and DejaVu download hashes and installs a hash-locked Pillow wheel. Browser rendering uses the repository's pinned Archify checkout. The social card embeds its local font files and measures every line against the crop-safe area before writing a JPEG below 300 KB. Edit `og.svg` for Pages card wording. Change `scripts/docs-media/hero.svg.tpl` for the shared hero layout.

## Rebuild the terminal demos

On Linux, use Node 20+, npm, Git, Bash, Python 3.11+ with SQLite, Pillow
and the DejaVu Sans and Mono fonts. Run from a ForgeKit checkout:

```sh
python3 scripts/make-demo-gif.py
python3 scripts/make-demo-gif.py setup
python3 scripts/make-social-images.py
```

The first command rebuilds the complete set. Pass `setup`, `verify`, `precommit`,
`memory`, `cost` or `doctor` to rebuild one example. Set `FORGE_DEMO_FONTS`
to the directory containing DejaVu's TrueType files if they are elsewhere.

Each recording uses a disposable Git repository with its own home and ForgeKit
state. The setup demo presents selected JSON fields as a table. The other
recordings show excerpts of the command output and the observed exit status.
A command change that removes an expected observation stops the render. The
setup sequence configures project files; Kimi still needs a user plugin install
and reload, and Codex needs project trust and hook review. The demos use no
production tenant, model or credentials.

## Illustrations

The other generated art lives next to the page that uses it:

- `landing/media/evidence-bg.webp`: the landing page's evidence band. A 55% veil keeps its
  text at 5.4:1 contrast or better, and it is dropped under `prefers-contrast: more`.
- `mintlify/images/illustrations/*.webp`: the opening illustrations of seven docs-site
  pages.

All of this art was generated for this project in September 2026 as text-free geometric
illustration in the brand palette (`brand.json`). It contains no sacred script. It
illustrates ideas; it is not data. The diagrams are rendered from typed sources in
[`docs/diagrams`](../diagrams/README.md), and every number the site states comes from the
reports in the repository.
