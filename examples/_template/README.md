# Example: <name>

> One paragraph: which pain point this demonstrates, and the "aha" moment the
> reader should walk away with.

## The pain

<2–3 sentences: what goes wrong without Forge. Be concrete, not marketing.>

## Run it

```bash
# from the repo root (node src/cli.js is the CLI entry; or use an installed `forge`)
forge() { node "$PWD/src/cli.js" "$@"; }
demo_dir="$(mktemp -d)" && cd "$demo_dir"
# ... steps ...
```

## What to look at

- <the one line of output that proves the point>
- <the second thing worth noticing>

## Cleanup

<Anything the demo leaves behind, and how to remove it. Prefer demos that need
no cleanup: work in `$demo_dir` and override homes via env vars.>

## Files

- `demo.sh` — the steps above as an executable script
- `demo.gif` — screen recording of the real output, rendered by a
  `scripts/make-<name>-gif.py` script from captured real CLI output into
  `mintlify/images/` and linked here (never hand-drawn)
