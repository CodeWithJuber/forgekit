import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { aggregateLocalTable, eligibleLocalRows, readLocalSource } from "../src/source_local.js";

function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), "forge-local-test-"));
  const source = { id: "handbook", root: join(temp, "docs") };
  mkdirSync(source.root);
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  return {
    source,
    temp,
    write: (file, content) => writeFileSync(join(source.root, file), content),
  };
}

const python = process.platform === "win32" ? "python" : "python3";
const hasPython = spawnSync(python, ["-I", "-c", "import csv"]).status === 0;
const hasSheet = (module) => spawnSync(python, ["-I", "-c", `import ${module}`]).status === 0;

test("local snapshots cite original lines, skip ignored/hidden paths and symlinks, redact before splitting", async (t) => {
  const { source, temp, write } = fixture(t);
  write(".gitignore", "private-*.md\n");
  write("private-notes.md", "do not index");
  write(".env.md", "do not index");
  writeFileSync(join(temp, "outside.txt"), "do not index");
  if (process.platform !== "win32")
    symlinkSync(join(temp, "outside.txt"), join(source.root, "link.txt"));
  const pemBoundary = (side) => ["-----", side, " PRIVATE KEY", "-----"].join("");
  write(
    "public.md",
    [
      "Introduction",
      pemBoundary("BEGIN"),
      ...Array(50).fill("privatepemline"),
      pemBoundary("END"),
      "Public final sentence.",
    ].join("\n"),
  );
  // Exercise both non-repository folders and ignored files force-added to an index.
  for (let pass = 0; pass < 2; pass++) {
    if (pass) {
      execFileSync("git", ["init", "-q"], { cwd: source.root });
      execFileSync("git", ["add", "-f", "private-notes.md"], { cwd: source.root });
    }
    const { chunks } = await readLocalSource(source);
    assert.deepEqual([...new Set(chunks.map((c) => c.path))], ["public.md"]);
    assert.match(chunks.at(-1).locator, /54$/);
    assert.match(chunks.at(-1).text, /Public final sentence/);
    assert.doesNotMatch(JSON.stringify(chunks), /privatepemline/);
  }
});

test("repository fsmonitor configuration cannot execute a command during source discovery", {
  skip: process.platform === "win32",
}, async (t) => {
  const { source, write } = fixture(t);
  execFileSync("git", ["init", "-q"], { cwd: source.root });
  execFileSync("git", ["config", "core.fsmonitor", "touch FS_MONITOR_EXECUTED"], {
    cwd: source.root,
  });
  write("source.txt", "valid text");
  const result = await readLocalSource(source);
  assert.equal(result.chunks.length, 1);
  assert.equal(existsSync(join(source.root, "FS_MONITOR_EXECUTED")), false);
});

test("local sources exclude private Forge state even when configured inside a public folder", async (t) => {
  const { source, write } = fixture(t);
  const previous = process.env.FORGE_HOME;
  t.after(() =>
    previous === undefined ? delete process.env.FORGE_HOME : (process.env.FORGE_HOME = previous),
  );
  process.env.FORGE_HOME = join(source.root, "personal");
  mkdirSync(process.env.FORGE_HOME);
  write("personal/cache.csv", "private");
  write("public.md", "public");
  const rows = await readLocalSource(source);
  assert.deepEqual(
    rows.chunks.map((c) => c.path),
    ["public.md"],
  );
  await assert.rejects(
    readLocalSource({ ...source, root: process.env.FORGE_HOME }),
    /private state/,
  );
  await assert.rejects(
    aggregateLocalTable(source, { path: "personal/cache.csv", operation: "count" }),
    /ignored/,
  );
});

test("conversion cache reuses complete snapshots and drops changed and deleted files", async (t) => {
  const { source, write } = fixture(t);
  write("a.txt", "First");
  write("b.txt", "Second");
  const first = await readLocalSource(source);
  assert.equal((await readLocalSource(source, { previousChunks: first.chunks })).reusedFiles, 2);
  rmSync(join(source.root, "b.txt"));
  write("a.txt", "12345\n".repeat(80));
  const next = await readLocalSource(source, { previousChunks: first.chunks, maxChunks: 1 });
  assert.equal(next.truncated, true);
  assert.equal(next.reusedFiles, 0);
  assert.equal(next.chunks[0].complete, false);
  const full = await readLocalSource(source, { previousChunks: next.chunks });
  assert.equal(full.reusedFiles, 0);
  assert.ok(full.chunks.length > 1);
  assert.ok(full.chunks.every((row) => row.path === "a.txt" && row.complete));
});

test("real CSV and TSV parser handles multiline quoting, BOM, groups, blanks, and exact decimals", {
  skip: !hasPython,
}, async (t) => {
  const { source, write } = fixture(t);
  write(
    "data.csv",
    '\ufeffregion,item,amount\r\nUAE,"milk, fresh",0.1\r\nUAE,"tea\nleaves",0.2\r\nIndia,rice,\r\n',
  );
  write("notes.tsv", "name\tvalue\nX\t8\n");
  const found = await readLocalSource(source);
  assert.deepEqual(found.warnings, []);
  assert.match(found.chunks[0].text, /tea\\nleaves/);
  assert.match(found.chunks[0].locator, /rows 1-4/);
  const query = { path: "data.csv", groupBy: "region", column: "amount" };
  const result = await aggregateLocalTable(source, { ...query, operation: "sum" });
  assert.equal(result.rowsScanned, 3);
  assert.deepEqual(result.groups, [
    { group: "UAE", value: "0.3", count: 2 },
    { group: "India", value: null, count: 0 },
  ]);
  for (const [op, expected] of [
    ["min", "0.1"],
    ["max", "0.2"],
    ["avg", "0.15"],
    ["count", 2],
  ]) {
    assert.equal(
      (await aggregateLocalTable(source, { ...query, operation: op })).groups[0].value,
      expected,
    );
  }
  assert.equal(
    (await aggregateLocalTable(source, { path: "data.csv", operation: "count" })).groups[0].value,
    3,
  );
  assert.equal(
    (await aggregateLocalTable(source, { path: "notes.tsv", operation: "max", column: "value" }))
      .groups[0].value,
    "8",
  );
});

test("aggregate denies traversal, ignored files, ambiguous columns, invalid numbers, row overflows and secret columns", {
  skip: !hasPython,
}, async (t) => {
  const { source, temp, write } = fixture(t);
  write(".gitignore", "private*\n");
  write("private.csv", "x\n2");
  writeFileSync(join(temp, "out.csv"), "x\n3");
  write("duplicate.csv", "x,x\n1,2");
  write("invalid.csv", "x\n1\noops");
  write("log.csv", "x\n".repeat(100002));
  write("auth.csv", "api_token,client\nunrepeatable,client");
  const go = (path) => aggregateLocalTable(source, { path, operation: "sum", column: "x" });
  await assert.rejects(go("../out.csv"), /relative/);
  await assert.rejects(go("private.csv"), /ignored/);
  if (process.platform !== "win32") {
    symlinkSync(join(temp, "out.csv"), join(source.root, "outside.csv"));
    await assert.rejects(go("outside.csv"), /symlink/);
  }
  await assert.rejects(go("duplicate.csv"), /ambiguous/);
  await assert.rejects(go("invalid.csv"), /non-numeric/);
  await assert.rejects(
    aggregateLocalTable(source, { path: "log.csv", operation: "count" }),
    /row limit/,
  );
  await assert.rejects(
    aggregateLocalTable(source, { path: "auth.csv", operation: "count", groupBy: "api_token" }),
    /sensitive/,
  );
  assert.equal(
    (await aggregateLocalTable(source, { path: "auth.csv", operation: "count", groupBy: "client" }))
      .groups[0].group,
    "client",
  );
});

test("real XLSX keeps visible sheet names, formulas inert, and requires selection for multiple sheets", {
  skip: !hasSheet("openpyxl"),
}, async (t) => {
  const { source } = fixture(t);
  execFileSync(python, [
    "-I",
    "-c",
    [
      "import openpyxl,sys",
      "w=openpyxl.Workbook(); s=w.active; s.title='Rates'; s.append(['name','value']); s.append(['first',12.5])",
      "s=w.create_sheet('Formula'); s.append(['name','value']); s.append(['test','=10+2'])",
      "s=w.create_sheet('Private'); s.sheet_state='hidden'; s.append(['hidden-data']); w.save(sys.argv[1])",
    ].join("\n"),
    join(source.root, "rates.xlsx"),
  ]);
  const found = await readLocalSource(source);
  assert.deepEqual(found.warnings, []);
  assert.match(found.chunks[0].locator, /Rates \/ rows 1-2/);
  assert.doesNotMatch(JSON.stringify(found.chunks), /hidden-data/);
  await assert.rejects(
    aggregateLocalTable(source, { path: "rates.xlsx", operation: "count" }),
    /multiple sheets/,
  );
  await assert.rejects(
    aggregateLocalTable(source, {
      path: "rates.xlsx",
      operation: "sum",
      sheet: "Formula",
      column: "value",
    }),
    /non-numeric/,
  );
  assert.equal(
    (
      await aggregateLocalTable(source, {
        path: "rates.xlsx",
        operation: "sum",
        sheet: "Rates",
        column: "value",
      })
    ).groups[0].value,
    "12.5",
  );
});

test("legacy XLS BIFF rows are read and aggregated", { skip: !hasSheet("xlrd") }, async (t) => {
  const { source, write } = fixture(t);
  // BIFF4 worksheet stream containing Name/Price and Rice/12.4, authored for this test.
  write(
    "legacy.xls",
    Buffer.from(
      "09080800000410000000000004020c0000000000000004004e616d6504020d000000010000000500507269636504020c0001000000000004005269636504020c00010001000000040031322e340a000000",
      "hex",
    ),
  );
  const found = await readLocalSource(source);
  assert.deepEqual(found.warnings, []);
  assert.match(found.chunks[0].locator, /Sheet 1 \/ rows 1-2/);
  assert.equal(
    (await aggregateLocalTable(source, { path: "legacy.xls", operation: "sum", column: "Price" }))
      .groups[0].value,
    "12.4",
  );
});

test("credential columns are masked while token-usage and cost telemetry remains queryable", {
  skip: !hasPython,
}, async (t) => {
  const { source, write } = fixture(t);
  write("usage.csv", "apiToken,input_tokens,charge\nsecret-test-cell,700,2.40");
  const result = await readLocalSource(source);
  assert.deepEqual(result.warnings, []);
  assert.doesNotMatch(result.chunks[0].text, /secret-test-cell/);
  assert.match(result.chunks[0].text, /REDACTED/);
  const aggregate = await aggregateLocalTable(source, {
    path: "usage.csv",
    column: "input_tokens",
    operation: "sum",
  });
  assert.equal(aggregate.groups[0].value, "700");
});

test("PDF content has real page locators; a corrupt PDF does not discard neighboring files", {
  skip: spawnSync("pdftotext", ["-v"]).status !== 0,
}, async (t) => {
  const { source, write } = fixture(t);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    ...[6, 7].map(
      (ref) =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents ${ref} 0 R >>`,
    ),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...["Page one", "Page two"].map((txt) => {
      const stream = `BT /F1 12 Tf 15 100 Td (${txt}) Tj ET\n`;
      return `<< /Length ${stream.length} >>\nstream\n${stream}endstream`;
    }),
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, body] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf +=
    `xref\n0 ${offsets.length}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
      .join("") +
    `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  write("guide.pdf", pdf);
  write("corrupt.pdf", "not a pdf");
  const result = await readLocalSource(source);
  assert.equal(result.warnings.length, 1);
  assert.ok(
    result.chunks.some(
      (c) =>
        c.path === "guide.pdf" && c.locator.startsWith("page 2") && c.text.includes("Page two"),
    ),
  );
});

test("cached reads recheck changed, deleted, newly ignored, and replaced linked files", async (t) => {
  const { source, write } = fixture(t);
  const paths = ["changed.md", "deleted.md", "ignore.md", "link.md", "valid.md"];
  for (const file of paths) write(file, "was authorized");
  const first = await readLocalSource(source);
  assert.deepEqual([...eligibleLocalRows(source, first.chunks)].sort(), paths);
  write(".gitignore", "ignore.md");
  write("changed.md", "now different");
  rmSync(join(source.root, "deleted.md"));
  rmSync(join(source.root, "link.md"));
  if (process.platform !== "win32")
    symlinkSync(join(source.root, "valid.md"), join(source.root, "link.md"));
  assert.deepEqual([...eligibleLocalRows(source, first.chunks)], ["valid.md"]);
});
