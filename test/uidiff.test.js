import assert from "node:assert/strict";
import { test } from "node:test";
import { presentationalOnly, uiSkeleton } from "../src/uidiff.js";

// Each case: [name, before, after]. The gate treats a presentational-only diff as a UI
// change (owes a design/state record or a UI check), everything else as code.
const PRESENTATIONAL = [
  [
    "a Tailwind className tweak",
    'export const Hero = () => <h1 className="text-xl">Hi</h1>;\n',
    'export const Hero = () => <h1 className="text-2xl font-semibold">Hi</h1>;\n',
  ],
  [
    "JSX text on the same line",
    'export const Hero = () => <h1 className="text-xl">Hi there</h1>;\n',
    'export const Hero = () => <h1 className="text-xl">Hello, world!</h1>;\n',
  ],
  [
    "multi-line JSX text",
    'return (\n  <p className="x">\n    Fast hosting\n  </p>\n);',
    'return (\n  <p className="x">\n    Fast, reliable hosting for everyone\n  </p>\n);',
  ],
  [
    "a cn() className expression, conditions included",
    '<div className={cn("px-2", active && "bg-a")} />',
    '<div className={cn("px-3 py-1", isOpen && "bg-b", open && "ring")} />',
  ],
  [
    "a style object",
    '<div style={{ width: 20, color: "red" }} />',
    '<div style={{ width: 24, color: "blue" }} />',
  ],
  [
    "cva variant strings",
    'const b = cva("inline-flex", { variants: { size: { sm: "h-8", lg: "h-10" } } });',
    'const b = cva("inline-flex gap-2", { variants: { size: { sm: "h-9", lg: "h-11" } } });',
  ],
  [
    "a className template literal",
    '<div className={`px-2 \u0024{a ? "x" : "y"}`} />', // \u0024 = $ (a template in the INPUT)
    '<div className={`px-4 \u0024{a ? "z" : "y"}`} />',
  ],
  [
    "a className object key in a props table",
    'const items = [{ label: "A", className: "text-red" }];',
    'const items = [{ label: "A", className: "text-blue" }];',
  ],
  [
    "JSX text after an arrow-function prop",
    "<Button onClick={() => go()}>Buy</Button>",
    "<Button onClick={() => go()}>Buy now</Button>",
  ],
  [
    "returned JSX text",
    "function A(){ return <p>Old</p> }",
    "function A(){ return <p>New copy</p> }",
  ],
  ["a comment only", "const a = 1; // old", "const a = 1; // new comment"],
];

const CODE = [
  [
    "a new variant key",
    'const b = cva("x", { variants: { size: { sm: "h-8" } } });',
    'const b = cva("x", { variants: { size: { sm: "h-8", md: "h-9" } } });',
  ],
  [
    "a handler added",
    '<button className="a">Go</button>',
    '<button className="a" onClick={go}>Go</button>',
  ],
  [
    "a handler argument",
    "<button onClick={() => go(1)}>Go</button>",
    "<button onClick={() => go(2)}>Go</button>",
  ],
  ["a logic string", 'const role = "admin";', 'const role = "user";'],
  ["an href", '<a href="/x">X</a>', '<a href="/y">X</a>'],
  ["a new element", '<div className="a">A</div>', '<div className="a">A<span>B</span></div>'],
  // TS generics and comparisons look like tags once whitespace is gone — never JSX text.
  [
    "a parameter behind a TS generic",
    "function f<T>(opts: Opts<T>) { return 1 }",
    "function f<T>(options: Opts<T>) { return 1 }",
  ],
  [
    "an implements clause",
    "class A<T> implements Bar { x = 1 }",
    "class A<T> implements Baz { x = 1 }",
  ],
  ["a comparison operand", "if (a < b && c > d) { go(); }", "if (a < b && c > e) { go(); }"],
  ["a return value", "return x", "return y"],
  ["a className equality test", 'if (className === "a") go();', 'if (className === "b") go();'],
  [
    "an import next to a className tweak",
    'import a from "a";\n<div className="x"/>',
    'import a from "a";\nimport b from "b";\n<div className="y"/>',
  ],
];

// Review: the attribute names are only presentational in JSX attribute position (or, in
// .jsx/.tsx, as a `className:` / `style: {…}` props key). Each is a logic change.
const JS = { tags: true, keys: false };
const TS = { tags: false, keys: false };
const TSX = { tags: true, keys: true };
const NOT_ATTRIBUTES = [
  [
    "Intl's `style` option",
    'new Intl.NumberFormat("en", { style: "currency" })',
    'new Intl.NumberFormat("en", { style: "percent" })',
    TSX,
  ],
  [
    "a static className field",
    "class P { static className = 'PaymentService' }",
    "class P { static className = 'RefundService' }",
    TS,
  ],
  [
    "a `style` variable a comparison reads",
    "let style = 'compact'; if (style === 'compact') go();",
    "let style = 'wide'; if (style === 'compact') go();",
    TSX,
  ],
  ["a `class:` data key", "const u = { class: 'admin' };", "const u = { class: 'guest' };", TSX],
  [
    "a className key outside .jsx/.tsx",
    'const o = { className: "X" };',
    'const o = { className: "Y" };',
    JS,
  ],
  ["a member assignment", "this.className = 'a';", "this.className = 'b';", TSX],
  [
    "a call hidden in a className expression",
    "<div className={'a'} />",
    "<div className={(deleteAll(), 'a')} />",
    TSX,
  ],
  [
    "an assignment hidden in a style object",
    "<div style={{ w: 1 }} />",
    "<div style={{ w: (x = 2) }} />",
    TSX,
  ],
  [
    "a TSX generic arrow is not a tag",
    "const f = <T,>(x: T) => { className = 'a' }",
    "const f = <T,>(x: T) => { className = 'b' }",
    TSX,
  ],
];

// JSX the attribute-position rule must still see as presentation.
const JSX_CONTEXTS = [
  [
    "an inline element after JSX text",
    '<p>Starting at <span className="font-bold">$2</span></p>',
    '<p>Starting at <span className="font-semibold text-lg">$2</span></p>',
    TSX,
  ],
  [
    "an apostrophe in JSX text",
    '<p>Don\'t click <b className="x">here</b></p>',
    '<p>Don\'t click <b className="y">here</b></p>',
    TSX,
  ],
  [
    "multi-line attributes",
    '<div\n  id="a"\n  className="p-2"\n  onClick={go}\n>x</div>',
    '<div\n  id="a"\n  className="p-4 m-1"\n  onClick={go}\n>x</div>',
    TSX,
  ],
  [
    "an element returned from a map callback",
    '<ul>{items.map((it) => <li key={it} className="a">{it}</li>)}</ul>',
    '<ul>{items.map((it) => <li key={it} className="b c">{it}</li>)}</ul>',
    TSX,
  ],
  [
    "an element inside an attribute",
    '<A icon={<I className="h-4" />} />',
    '<A icon={<I className="h-5" />} />',
    TSX,
  ],
  [
    "a new key in a style object",
    "<div style={{ width: 20 }} />",
    "<div style={{ width: 20, padding: 4 }} />",
    TSX,
  ],
  ["a CSS-module class", "<div className={styles.a} />", "<div className={styles.b} />", TSX],
  [
    "a URL in JSX text",
    '<a href="/x">https://x.com/old</a>',
    '<a href="/x">https://x.com/new</a>',
    TSX,
  ],
  [
    "JSX in a .js file",
    'export default () => <h1 className="a">Hi</h1>;',
    'export default () => <h1 className="b">Hi</h1>;',
    JS,
  ],
  [
    "cva variant strings in a .ts file",
    'export const b = cva("inline-flex", { variants: { size: { sm: "h-8" } } });',
    'export const b = cva("inline-flex gap-2", { variants: { size: { sm: "h-9" } } });',
    TS,
  ],
];

test("presentationalOnly: className/style outside JSX attribute position is code", () => {
  for (const [name, before, after, opts] of NOT_ATTRIBUTES)
    assert.equal(presentationalOnly(before, after, opts), false, name);
});

test("presentationalOnly: JSX attribute position is found across real component shapes", () => {
  for (const [name, before, after, opts] of JSX_CONTEXTS)
    assert.equal(presentationalOnly(before, after, opts), true, name);
});

test("presentationalOnly: className/class/style values, variant strings and JSX text", () => {
  for (const [name, before, after] of PRESENTATIONAL)
    assert.equal(presentationalOnly(before, after), true, name);
});

test("presentationalOnly: anything else that moved keeps the file code", () => {
  for (const [name, before, after] of CODE)
    assert.equal(presentationalOnly(before, after), false, name);
});

test("presentationalOnly: identical, new or deleted sources are not a UI change", () => {
  assert.equal(presentationalOnly("x", "x"), false, "nothing moved");
  assert.equal(presentationalOnly(null, "<p>new</p>"), false, "a new file is code");
  assert.equal(presentationalOnly("<p>gone</p>", undefined), false, "a deleted file is code");
});

test("uiSkeleton: kept strings stay comparable, presentational ones are blanked", () => {
  assert.notEqual(
    uiSkeleton('f("a b")'),
    uiSkeleton('f("ab")'),
    "whitespace in a logic string counts",
  );
  assert.equal(uiSkeleton('<i className="a b" />'), uiSkeleton('<i className="ab" />'));
  // Linear on pathological input: many arrows in one tag, many unclosed tags.
  const t = Date.now();
  uiSkeleton(`<a${"=>".repeat(50000)}`);
  uiSkeleton("(<a".repeat(30000));
  assert.ok(Date.now() - t < 2000, "no catastrophic backtracking");
});
