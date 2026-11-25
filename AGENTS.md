# Contributing to ForgeKit

ForgeKit is an ESM Node CLI for shared project memory, verification and agent integrations. Keep the core usable on Node 20 and later with zero production npm dependencies. Python 3 with SQLite is needed for features that use the Python workers. Contributor commands and conventions are in [CLAUDE.md](CLAUDE.md).

- Use `npm ci` for a clean development install. Run `node src/cli.js` to try the CLI directly.
- Run focused tests with `node --test --import ./test/_setup.js test/<name>.test.js`. Use `npm test`, `npm run check` and `npm run typecheck` for release verification.
- After changing published commands or capabilities, run `node src/cli.js docs render` and `node src/cli.js docs check`. Preserve handwritten content outside generated blocks.
- Use synthetic inputs and local transports for routine tests. Record the actual host, provider, parser and verification scope for integration evidence.
