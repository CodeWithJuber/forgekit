// tsconfig/jsconfig path aliases (`@/*`, `~/*`, baseUrl) in the ONE import resolver
// (scope.resolveSpec) and everything built on it: the file graph (scope, rank, collide),
// the symbol graph (atlas) and the blast radius (impact). Before this, a Next.js repo that
// imports through `@/…` had nearly every import filed as an external package — no edges,
// empty impact, and `unresolved: 0` in the stats hiding it.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { build, impact, isStale } from "../src/atlas.js";
import {
  directedImportGraph,
  loadPathAliases,
  localImports,
  matchPathAlias,
  parseJsonc,
  resolveSpec,
} from "../src/scope.js";
import { predictImpact } from "../src/substrate.js";
import { NEXT_IMPORTERS, nextFiles, writeRepo } from "./fixtures/impact_repos.mjs";

const tsconfig = (compilerOptions, extra = {}) => JSON.stringify({ compilerOptions, ...extra });

// --- parseJsonc ---------------------------------------------------------------------

test("parseJsonc strips comments and trailing commas, but never inside a string", () => {
  const text = `\uFEFF{
    // line comment with "quotes" and a trailing comma,
    "paths": { "@/*": ["./src/*"], /* block */ },
    "include": ["**/*.ts", "**/*.tsx",],
    "url": "https://example.com/a//b", // a // inside a string is not a comment
    "odd": "a,]b /* not a comment */ c\\"d",
  }`;
  assert.deepEqual(parseJsonc(text), {
    paths: { "@/*": ["./src/*"] },
    include: ["**/*.ts", "**/*.tsx"],
    url: "https://example.com/a//b",
    odd: 'a,]b /* not a comment */ c"d',
  });
  assert.throws(() => parseJsonc("{ nope }"), SyntaxError);
});

// --- loadPathAliases ------------------------------------------------------------------

test('loadPathAliases keeps "@/*" when "**/*.ts" in include looks like a comment pair', () => {
  const aliases = loadPathAliases(writeRepo(nextFiles));
  assert.deepEqual(aliases, [
    { pattern: "@/*", prefix: "@/", suffix: "", star: true, targets: ["src/*"], local: true },
  ]);
});

test("loadPathAliases: ~/* from jsconfig.json when there is no tsconfig.json", () => {
  const root = writeRepo({
    "jsconfig.json": tsconfig({ paths: { "~/*": ["./app/*"] } }),
    "app/utils/format.js": "export const fmt = (x) => String(x);\n",
    "app/routes/index.jsx": 'import { fmt } from "~/utils/format";\nexport default () => fmt(1);\n',
  });
  const aliases = loadPathAliases(root);
  assert.deepEqual(aliases[0].targets, ["app/*"]);
  const g = directedImportGraph(root);
  assert.ok(g.edges.get("app/routes/index.jsx").has("app/utils/format.js"));
});

test("loadPathAliases: an unreadable tsconfig.json falls through to jsconfig.json; none → []", () => {
  const root = writeRepo({
    "tsconfig.json": "{ this is not json",
    "jsconfig.json": tsconfig({ paths: { "#lib/*": ["lib/*"] } }),
  });
  assert.equal(loadPathAliases(root)[0].pattern, "#lib/*");
  assert.deepEqual(loadPathAliases(writeRepo({ "a.js": "" })), []);
});

test("loadPathAliases: baseUrl alone is a fallback rule that resolves bare paths but is not local", () => {
  const root = writeRepo({ "tsconfig.json": tsconfig({ baseUrl: "src" }) });
  const aliases = loadPathAliases(root);
  assert.deepEqual(aliases, [
    {
      pattern: "*",
      prefix: "",
      suffix: "",
      star: true,
      targets: ["src/*"],
      local: false,
      fallback: true,
    },
  ]);
  const files = new Set(["src/components/Button.tsx", "src/lib/api/index.ts"]);
  assert.equal(
    resolveSpec("src/app.tsx", "components/Button", files, aliases),
    "src/components/Button.tsx",
  );
  assert.equal(resolveSpec("src/app.tsx", "lib/api", files, aliases), "src/lib/api/index.ts");
  assert.equal(
    resolveSpec("src/app.tsx", "react", files, aliases),
    null,
    "a package stays external",
  );
  assert.equal(matchPathAlias("react", aliases), null, "the baseUrl rule never marks a spec local");
});

test("loadPathAliases follows relative extends: paths resolve from the base config's dir", () => {
  const root = writeRepo({
    // no `.json` on the extends path, as tsc allows; the base sets its own baseUrl
    "tsconfig.json": tsconfig({ strict: true }, { extends: "./config/tsconfig.base" }),
    "config/tsconfig.base.json": tsconfig({ baseUrl: "..", paths: { "@app/*": ["src/*"] } }),
  });
  assert.deepEqual(loadPathAliases(root)[0].targets, ["src/*"]);
  // `paths` with no baseUrl anywhere resolve against the config that DECLARED them.
  const noBase = writeRepo({
    "tsconfig.json": tsconfig({}, { extends: "./config/base.json" }),
    "config/base.json": tsconfig({ paths: { "#lib/*": ["../lib/*"] } }),
  });
  assert.deepEqual(loadPathAliases(noBase)[0].targets, ["lib/*"]);
  // A child's baseUrl re-anchors the base's paths; later array bases override earlier ones.
  const child = writeRepo({
    "tsconfig.json": tsconfig({ baseUrl: "packages" }, { extends: ["./a.json", "./b.json"] }),
    "a.json": tsconfig({ paths: { "@x/*": ["old/*"] } }),
    "b.json": tsconfig({ paths: { "@x/*": ["x/src/*"] } }),
  });
  assert.deepEqual(loadPathAliases(child).filter((a) => !a.fallback)[0].targets, [
    "packages/x/src/*",
  ]);
  // A package base (node_modules) and a cycle are both survivable.
  const cyc = writeRepo({
    "tsconfig.json": tsconfig(
      { paths: { "@/*": ["src/*"] } },
      { extends: ["@tsconfig/next", "./loop.json"] },
    ),
    "loop.json": JSON.stringify({ extends: "./tsconfig.json" }),
  });
  assert.deepEqual(loadPathAliases(cyc)[0].targets, ["src/*"]);
});

test("loadPathAliases: extends tries the path as written before appending .json (as tsc does)", () => {
  // A `.jsonc` base: appending `.json` blindly would look for `tsconfig.base.jsonc.json`.
  const jsonc = writeRepo({
    "tsconfig.json": tsconfig({}, { extends: "./tsconfig.base.jsonc" }),
    "tsconfig.base.jsonc": `{ // shared\n "compilerOptions": { "paths": { "@/*": ["src/*"], }, }, }`,
  });
  assert.deepEqual(loadPathAliases(jsonc)[0].targets, ["src/*"]);
  // An extensionless base that exists on disk wins over `<name>.json`.
  const bare = writeRepo({
    "tsconfig.json": tsconfig({}, { extends: "./config/base" }),
    "config/base": tsconfig({ paths: { "~/*": ["../app/*"] } }),
    "config/base.json": tsconfig({ paths: { "~/*": ["../wrong/*"] } }),
  });
  assert.deepEqual(loadPathAliases(bare)[0].targets, ["app/*"]);
});

test("loadPathAliases: a baseUrl or target outside the repo is never local", () => {
  const up = loadPathAliases(
    writeRepo({ "tsconfig.json": tsconfig({ baseUrl: "..", paths: { "@/*": ["src/*"] } }) }),
  );
  assert.deepEqual(
    up.map((a) => [a.pattern, a.targets, a.local]),
    [
      ["@/*", ["../src/*"], false],
      ["*", ["../*"], false],
    ],
  );
  const sibling = loadPathAliases(
    writeRepo({
      "tsconfig.json": tsconfig({ paths: { "@shared/*": ["../shared/*"], "@/*": ["./src/*"] } }),
    }),
  );
  assert.deepEqual(
    sibling.map((a) => [a.pattern, a.local]),
    [
      ["@shared/*", false],
      ["@/*", true],
    ],
  );
  assert.equal(resolveSpec("src/a.ts", "@shared/x", new Set(["shared/x.ts"]), sibling), null);
});

test("loadPathAliases orders exact, then longest prefix; catch-all and node_modules are not local", () => {
  const aliases = loadPathAliases(
    writeRepo({
      "tsconfig.json": tsconfig({
        paths: {
          "*": ["types/*"],
          "@/*": ["src/*"],
          "@/ui/*": ["src/components/ui/*"],
          config: ["src/config/index.ts"],
          "vendored/*": ["node_modules/vendored/*"],
          "a*b*": ["never/*"],
        },
      }),
    }),
  );
  assert.deepEqual(
    aliases.map((a) => a.pattern),
    ["config", "vendored/*", "@/ui/*", "@/*", "*"],
    "exact first, longest prefix next, two-star patterns dropped (tsc rejects them)",
  );
  const local = Object.fromEntries(aliases.map((a) => [a.pattern, a.local]));
  assert.deepEqual(local, {
    config: true,
    "vendored/*": false,
    "@/ui/*": true,
    "@/*": true,
    "*": false,
  });
  assert.deepEqual(matchPathAlias("@/ui/button?raw", aliases), {
    alias: aliases[2],
    rest: "button",
  });
});

// --- resolveSpec with aliases ------------------------------------------------------------

test("resolveSpec: an alias goes through the same candidate expansion as a relative spec", () => {
  const aliases = loadPathAliases(
    writeRepo({
      "tsconfig.json": tsconfig({
        baseUrl: ".",
        paths: {
          "@/*": ["src/*", "generated/*"],
          "@/ui/*": ["src/components/ui/*"],
          "#cfg": ["src/config/index.ts"],
        },
      }),
    }),
  );
  const files = new Set([
    "src/lib/utils.ts",
    "src/lib/esm.ts",
    "src/widgets/index.tsx",
    "src/components/ui/button.tsx",
    "src/ui/card.tsx",
    "generated/schema.ts",
    "src/config/index.ts",
    "shared/tokens.ts",
    "src/odd$&name.ts",
  ]);
  const r = (spec) => resolveSpec("src/app/page.tsx", spec, files, aliases);
  assert.equal(r("@/lib/utils"), "src/lib/utils.ts", "extensionless");
  assert.equal(r("@/lib/esm.js"), "src/lib/esm.ts", "NodeNext .js → .ts twin");
  assert.equal(r("@/widgets"), "src/widgets/index.tsx", "directory index");
  assert.equal(r("@/schema"), "generated/schema.ts", "second target when the first misses");
  assert.equal(r("@/ui/button"), "src/components/ui/button.tsx", "longest prefix wins");
  assert.equal(r("@/ui/card"), null, "tsc tries only the best pattern, not the shorter @/*");
  assert.equal(
    r("#cfg"),
    "src/config/index.ts",
    "an exact (star-less) pattern; # is not a fragment",
  );
  assert.equal(r("@/lib/utils?inline"), "src/lib/utils.ts", "a query suffix is stripped");
  assert.equal(r("shared/tokens"), "shared/tokens.ts", "baseUrl fallback after paths");
  assert.equal(r("@/../../etc/passwd"), null, "an alias cannot escape the repo");
  assert.equal(r("@/odd$&name"), "src/odd$&name.ts", "`$&` in the capture is not a pattern");
  assert.equal(resolveSpec("src/a.ts", "@/lib/utils", files), null, "no aliases → unchanged");
});

test("localImports and the file graph follow aliases (scope, rank and collide share it)", () => {
  const root = writeRepo(nextFiles);
  const g = directedImportGraph(root);
  for (const [target, importers] of Object.entries(NEXT_IMPORTERS))
    for (const f of importers) assert.ok(g.edges.get(f).has(target), `${f} → ${target}`);
  const text = 'import { cn } from "@/lib/utils";\n';
  const fileSet = new Set(["src/lib/utils.ts", "src/x.ts"]);
  assert.deepEqual([...localImports("src/x.ts", text, fileSet)], [], "aliases are opt-in");
  assert.deepEqual(
    [...localImports("src/x.ts", text, fileSet, undefined, loadPathAliases(root))],
    ["src/lib/utils.ts"],
  );
});

// --- atlas + impact ---------------------------------------------------------------------

test("atlas: a Next.js-style repo resolves every @/ import; recall 13/13 (was 1/13)", () => {
  const atlas = build({ root: writeRepo(nextFiles) });
  let pairs = 0;
  for (const [target, importers] of Object.entries(NEXT_IMPORTERS)) {
    const got = impact(atlas, target, { relations: ["reverse"] }).impactedFiles;
    for (const f of importers) {
      pairs += 1;
      assert.ok(got.includes(f), `impact(${target}) missed ${f}`);
    }
  }
  assert.equal(pairs, 13);
  // Named imports through the alias bind call edges too.
  assert.ok(impact(atlas, "getProducts").impactedFiles.includes("src/app/api/products/route.ts"));
});

test("atlas: an alias miss is counted unresolved (not external); packages and assets unchanged", () => {
  const atlas = build({ root: writeRepo(nextFiles) });
  assert.deepEqual(atlas.stats.imports, {
    total: 18,
    resolved: 13,
    external: 2, // next/link, clsx
    unresolved: 1, // @/lib/legacy-pricing
    assets: 2, // ./globals.css, @/styles/theme.css
  });
  const miss = atlas.edges.find((e) => e.kind === "imports" && e.spec === "@/lib/legacy-pricing");
  assert.equal(miss?.reason, "not-found");
  assert.equal(miss?.external, undefined);
});

test("atlas: a miss under a NON-local rule (catch-all, node_modules target, baseUrl) stays external", () => {
  const atlas = build({
    root: writeRepo({
      "tsconfig.json": tsconfig({
        baseUrl: ".",
        paths: {
          "*": ["types/*"],
          "vendored/*": ["node_modules/vendored/*"],
          "@/*": ["src/*"],
        },
      }),
      "src/lib/utils.ts": "export const cn = (s: string) => s;\n",
      "src/app.ts":
        'import { cn } from "@/lib/utils";\nimport { v } from "vendored/thing";\nimport React from "react";\nimport { gone } from "@/lib/gone";\nexport const app = () => cn(String(v) + String(React) + String(gone));\n',
    }),
  });
  assert.deepEqual(atlas.stats.imports, {
    total: 4,
    resolved: 1, // @/lib/utils
    external: 2, // vendored/thing (node_modules target), react (catch-all + baseUrl)
    unresolved: 1, // @/lib/gone
    assets: 0,
  });
  const edge = (spec) => atlas.edges.find((e) => e.kind === "imports" && e.spec === spec);
  assert.equal(edge("vendored/thing")?.external, true);
  assert.equal(edge("react")?.external, true);
  assert.equal(edge("@/lib/gone")?.reason, "not-found");
});

test("atlas: editing tsconfig paths makes the atlas stale, and the rebuild uses the new rules", () => {
  const root = writeRepo(nextFiles);
  const atlas = build({ root });
  assert.equal(isStale(root, atlas), false);
  writeFileSync(join(root, "tsconfig.json"), tsconfig({ paths: { "~/*": ["./src/*"] } }));
  assert.equal(isStale(root, atlas), true);
  assert.equal(build({ root }).stats.imports.resolved, 1, "only the relative import is left");
});

test("forge impact (predictImpact) reports alias importers end to end", () => {
  const r = predictImpact(writeRepo(nextFiles), "src/lib/whmcs.ts", { basic: true, llm: false });
  for (const f of NEXT_IMPORTERS["src/lib/whmcs.ts"]) assert.ok(r.impactedFiles.includes(f), f);
});
