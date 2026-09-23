// Fixture repos for the impact-graph regression tests (atlas import resolution, Python
// package roots, sibling/forward relations, comment/string masking, call attribution).
// Each builder writes a tiny repo into a fresh temp dir and returns its root. The ground
// truth for every fixture is spelled out next to it, so a failing assertion can be checked
// by reading the fixture, not by trusting the graph.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Write `{relPath: text}` under a new temp dir; returns the root. */
export function writeRepo(files, prefix = "forge-impact-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

// js1 — src/util.js has exactly TEN direct importers, one per import form. Traps that must
// NOT be linked: a string and a comment naming "./util.js", and a DIFFERENT util.js in
// another directory (its importer resolves to that file, not this one).
export const JS1_IMPORTERS = [
  "src/d01_named.js",
  "src/d02_namespace.js",
  "src/d03_default_extensionless.js",
  "src/d04_export_star.js",
  "src/d05_export_rename.js",
  "src/d06_dynamic.js",
  "src/d07_require.cjs",
  "src/d08_side_effect.js",
  "src/nested/d09_multiline.js",
  "src/widgets/index.js",
];
export const js1Files = {
  "src/util.js":
    "export function helper(x) {\n  return x + 1;\n}\nexport function other() {\n  return 2;\n}\nexport default { helper };\n",
  "src/d01_named.js": 'import { helper } from "./util.js";\nexport const d01 = () => helper(1);\n',
  "src/d02_namespace.js":
    'import * as util from "./util.js";\nexport function d02() {\n  return util.helper(2);\n}\n',
  "src/d03_default_extensionless.js":
    'import util from "./util";\nexport function d03() {\n  return util.helper(3);\n}\n',
  "src/d04_export_star.js": 'export * from "./util.js";\n',
  "src/d05_export_rename.js": 'export { helper as increment } from "./util.js";\n',
  "src/d06_dynamic.js":
    'export async function d06() {\n  const m = await import("./util.js");\n  return m.helper(6);\n}\n',
  "src/d07_require.cjs":
    'const { helper } = require("./util.js");\nmodule.exports = () => helper(7);\n',
  "src/d08_side_effect.js": 'import "./util.js";\nexport const d08 = 8;\n',
  "src/nested/d09_multiline.js":
    'import {\n  helper,\n  other,\n} from "../util.js";\nexport function d09() {\n  return helper(other());\n}\n',
  // A directory package: imported below as "./widgets" (index.js directory import).
  "src/widgets/index.js":
    'import { other } from "../util.js";\nexport function widget() {\n  return other();\n}\n',
  "src/page.js": 'import { widget } from "./widgets";\nexport const page = () => widget();\n',
  // Traps.
  "src/noise.js":
    '// util helpers live in "./util.js" — this comment is not an import\nexport const doc = "see ./util.js";\n',
  "src/other/util.js": "export function helper() {\n  return 0;\n}\n",
  "src/other/consumer.js":
    'import { helper } from "./util.js";\nexport const consume = () => helper();\n',
};

// sib — serializer.js and deserializer.js share wire_format.js; app.js uses both.
// impact(serializer.js): reverse = app.js, sibling = deserializer.js, forward = wire_format.js.
export const sibFiles = {
  "src/wire_format.js":
    "export function encodeFrame(x) {\n  return JSON.stringify(x);\n}\nexport function decodeFrame(s) {\n  return JSON.parse(s);\n}\n",
  "src/serializer.js":
    'import { encodeFrame } from "./wire_format.js";\nexport function serialize(obj) {\n  return encodeFrame(obj);\n}\n',
  "src/deserializer.js":
    'import { decodeFrame } from "./wire_format.js";\nexport function deserialize(s) {\n  return decodeFrame(s);\n}\n',
  "src/app.js":
    'import { serialize } from "./serializer.js";\nimport { deserialize } from "./deserializer.js";\nexport function roundTrip(o) {\n  return deserialize(serialize(o));\n}\n',
};

// py_rel — pkg/core.py has exactly SEVEN importers, one per Python import form, including
// relative, parenthesised multi-line, aliased dotted, and an import after other imports.
export const PY_REL_IMPORTERS = [
  "pkg/a.py",
  "pkg/b.py",
  "pkg/c.py",
  "pkg/d.py",
  "pkg/sub/e.py",
  "pkg/f.py",
  "app.py",
];
export const pyRelFiles = {
  "pkg/__init__.py": "",
  "pkg/sub/__init__.py": "",
  "pkg/core.py":
    "def run():\n    return 1\n\n\ndef start():\n    return 2\n\n\nclass Engine:\n    pass\n",
  "pkg/a.py": "from .core import run\n\n\ndef a():\n    return run()\n",
  "pkg/b.py": "from . import core\n\n\ndef b():\n    return core.run()\n",
  "pkg/c.py":
    "from pkg.core import (\n    run,\n    start,\n)\n\n\ndef c():\n    return run() + start()\n",
  "pkg/d.py": "import pkg.core as c\n\n\ndef d():\n    return c.start()\n",
  "pkg/sub/e.py": "from ..core import start\n\n\ndef e():\n    return start()\n",
  "pkg/f.py":
    "import os\nimport sys\nfrom pkg.core import start\n\n\ndef f():\n    return start() + len(sys.argv) + len(os.sep)\n",
  "app.py": "from pkg import core\n\nprint(core.run())\n",
  // Trap: mentions pkg.core only in a comment and a string.
  "pkg/noise.py": '# from pkg.core import run  (commented out)\nDOC = "import pkg.core"\n',
};

// py_flat / py_src — the SAME package in a flat and in a src layout. cli.py imports
// mypkg.core by its absolute package name in both; both layouts must give [mypkg/cli.py].
// worker.py defines a second `run`, so a bare-name guess cannot paper over a wrong qname.
const MYPKG = {
  "mypkg/__init__.py": "",
  "mypkg/core.py": "def run():\n    return 1\n",
  "mypkg/worker.py": "def run():\n    return 2\n",
  "mypkg/cli.py": "from mypkg.core import run\n\n\ndef main():\n    return run()\n",
};
export const pyFlatFiles = { ...MYPKG, "pyproject.toml": '[project]\nname = "mypkg"\n' };
export const pySrcFiles = {
  ...Object.fromEntries(Object.entries(MYPKG).map(([k, v]) => [`src/${k}`, v])),
  "pyproject.toml": '[project]\nname = "mypkg"\n',
};

// coll — two files define `render`; each importer must resolve to ITS render.js.
export const collFiles = {
  "src/ui/render.js": 'export function render(x) {\n  return "<p>" + x + "</p>";\n}\n',
  "src/pdf/render.js": "export function render(x) {\n  return Buffer.from(String(x));\n}\n",
  "src/ui/view.js":
    'import { render } from "./render.js";\nexport function view(x) {\n  return render(x);\n}\n',
  "src/pdf/export.js":
    'import { render } from "./render.js";\nexport function exportPdf(x) {\n  return render(x);\n}\n',
};

// phantom — a comment that says `class Parser` must not create a second Parser symbol
// (which would make the name ambiguous and erase main.js's real edge).
export const phantomFiles = {
  "src/parser.js":
    "export class Parser {\n  parse(s) {\n    return s.split(',');\n  }\n}\nexport function makeParser() {\n  return new Parser();\n}\n",
  "src/main.js":
    'import { makeParser } from "./parser.js";\nexport function main() {\n  return makeParser().parse("a,b");\n}\n',
  "src/notes.js":
    '// class Parser is documented in parser.js; function makeParser() too\nexport const NOTE = "class Parser";\n',
};

// trans — mid() assigns leaf()'s result to a LOCAL const; top() calls mid(). The call to
// leaf() belongs to mid(), so impact(leaf) must reach top.js through mid.
export const transFiles = {
  "src/leaf.js": "export function leaf() {\n  return 1;\n}\n",
  "src/mid.js":
    'import { leaf } from "./leaf.js";\nexport function mid() {\n  const value = leaf();\n  return value * 2;\n}\n',
  "src/top.js":
    'import { mid } from "./mid.js";\nexport function top() {\n  return mid() + 1;\n}\n',
};

// ts1 — TypeScript NodeNext: `./x.js` in source refers to x.ts on disk.
export const ts1Files = {
  "src/x.ts": "export function fx(n: number): number {\n  return n * 2;\n}\n",
  "src/y.ts": 'import { fx } from "./x.js";\nexport const fy = (n: number) => fx(n) + 1;\n',
  "src/z.ts": 'export * from "./x.js";\n',
};

// next — a Next.js-shaped repo whose code imports through the tsconfig `@/*` path alias
// (as create-next-app scaffolds it), with one relative import mixed in. The tsconfig is
// JSONC: comments, trailing commas, and an `include` whose "**/*.ts" contains `/*` and
// `*/` — a naive comment regex would swallow the `"@/*"` key between them. Ground truth
// below is every DIRECT importer, read off the sources. Traps: `@/lib/legacy-pricing` does
// not exist (a broken LOCAL import: unresolved, not external), `next/link` and `clsx` are
// packages (external), and the two stylesheets are assets.
export const NEXT_IMPORTERS = {
  "src/lib/utils.ts": [
    "src/app/layout.tsx",
    "src/app/pricing/page.tsx",
    "src/components/header.tsx",
    "src/components/ui/button.tsx",
    "src/components/ui/card.tsx",
  ],
  "src/lib/whmcs.ts": [
    "src/app/api/products/route.ts",
    "src/app/page.tsx",
    "src/app/pricing/page.tsx",
  ],
  "src/components/ui/button.tsx": ["src/components/header.tsx", "src/components/index.ts"],
  "src/components/ui/card.tsx": ["src/app/page.tsx", "src/components/index.ts"],
  "src/components/header.tsx": ["src/app/layout.tsx"],
};
export const nextFiles = {
  "tsconfig.json": `{
  // create-next-app defaults, plus the JSONC a hand-edited config accumulates
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "strict": true,
    "jsx": "preserve", /* inline block comment */
    "paths": {
      "@/*": ["./src/*"],
    },
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules"],
}
`,
  "package.json":
    '{ "name": "next-like", "dependencies": { "next": "16.0.0", "clsx": "2.1.1" } }\n',
  "src/lib/utils.ts":
    'export function cn(...parts: string[]): string {\n  return parts.filter(Boolean).join(" ");\n}\n',
  "src/lib/whmcs.ts": "export async function getProducts(): Promise<string[]> {\n  return [];\n}\n",
  "src/components/ui/button.tsx":
    'import { cn } from "@/lib/utils";\nexport function Button({ className }: { className?: string }) {\n  return <button className={cn("btn", className ?? "")} />;\n}\n',
  "src/components/ui/card.tsx":
    'import { cn } from "@/lib/utils";\nexport function Card() {\n  return <div className={cn("card")} />;\n}\n',
  "src/components/header.tsx":
    'import Link from "next/link";\nimport { Button } from "@/components/ui/button";\nimport { cn } from "../lib/utils";\nexport function Header() {\n  return (\n    <header className={cn("h")}>\n      <Link href="/">\n        <Button />\n      </Link>\n    </header>\n  );\n}\n',
  "src/components/index.ts":
    'export * from "@/components/ui/button";\nexport { Card } from "@/components/ui/card";\n',
  "src/app/layout.tsx":
    'import "./globals.css";\nimport "@/styles/theme.css";\nimport { cn } from "@/lib/utils";\nimport { Header } from "@/components/header";\nexport default function RootLayout({ children }: { children: unknown }) {\n  return (\n    <html className={cn("root")}>\n      <body>\n        <Header />\n        {children}\n      </body>\n    </html>\n  );\n}\n',
  "src/app/page.tsx":
    'import { Card } from "@/components/ui/card";\nimport { getProducts } from "@/lib/whmcs";\nexport default async function Page() {\n  const products = await getProducts();\n  return <Card key={products.length} />;\n}\n',
  "src/app/pricing/page.tsx":
    'import { clsx } from "clsx";\nimport { cn } from "@/lib/utils";\nimport { getProducts } from "@/lib/whmcs";\nimport { legacyTiers } from "@/lib/legacy-pricing";\nexport default async function Pricing() {\n  const products = await getProducts();\n  return <main className={cn(clsx("p"), legacyTiers(products))} />;\n}\n',
  "src/app/api/products/route.ts":
    'import * as whmcs from "@/lib/whmcs";\nexport async function GET() {\n  return Response.json(await whmcs.getProducts());\n}\n',
};
