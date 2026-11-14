import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { doclingConfig } from "../src/source_documents.js";
import { readLocalSource } from "../src/source_local.js";

const python = process.platform === "win32" ? "python" : "python3";
const hasPython = spawnSync(python, ["-I", "-c", "import zipfile"]).status === 0;
const run = (code, ...args) => execFileSync(python, ["-I", "-c", code, ...args]);
function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), "forge-office-")),
    root = join(temp, "documents");
  mkdirSync(root);
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  return { temp, root, id: "office" };
}

test("index DOCX paragraphs/table rows and PPTX in presentation order, excluding hidden slides", {
  skip: !hasPython,
}, async (t) => {
  const source = fixture(t);
  run(
    `
import sys, zipfile
from pathlib import Path
root=Path(sys.argv[1])
W="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
P="http://schemas.openxmlformats.org/presentationml/2006/main"
A="http://schemas.openxmlformats.org/drawingml/2006/main"
R="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
with zipfile.ZipFile(root/"policy.docx","w") as z:
 z.writestr("word/document.xml",f'<w:document xmlns:w="{W}"><w:body><w:p><w:r><w:t>Approved </w:t><w:t>procedure</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>alpha</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>')
with zipfile.ZipFile(root/"brief.pptx","w") as z:
 z.writestr("ppt/presentation.xml",f'<p:presentation xmlns:p="{P}" xmlns:r="{R}"><p:sldIdLst><p:sldId r:id="r2"/><p:sldId r:id="r1"/><p:sldId r:id="r3"/></p:sldIdLst></p:presentation>')
 z.writestr("ppt/_rels/presentation.xml.rels",'<Relationships>'+''.join(f'<Relationship Id="r{i}" Type="{R}/slide" Target="slides/slide{i}.xml"/>' for i in range(1,4))+'</Relationships>')
 for i in range(1,4):
  z.writestr(f'ppt/slides/slide{i}.xml',f'<p:sld xmlns:p="{P}" xmlns:a="{A}" show="{int(i!=3)}"><a:p><a:r><a:t>Evidence item {i}</a:t></a:r></a:p></p:sld>')
`,
    source.root,
  );
  const res = await readLocalSource(source);
  assert.deepEqual(res.warnings, []);
  const doc = res.chunks.filter((c) => c.path === "policy.docx");
  assert.deepEqual(
    doc.map((c) => [c.locator, c.text]),
    [
      ["paragraph 1", "Approved procedure"],
      ["table 1 / row 1", "alpha | 42"],
    ],
  );
  assert.deepEqual(doc[0].structure, { paragraphs: 1, tables: 1 });
  const slides = res.chunks.filter((c) => c.path === "brief.pptx");
  assert.deepEqual(
    slides.map((c) => [c.locator, c.text]),
    [
      ["slide 1", "Evidence item 2"],
      ["slide 2", "Evidence item 1"],
    ],
  );
  assert.deepEqual(slides[0].structure, { slides: 3, visibleSlides: 2 });
  assert.equal((await readLocalSource(source, { previousChunks: res.chunks })).reusedFiles, 2);
});

test("Office readers reject unsafe XML and cap output without mistaking it for a complete document", {
  skip: !hasPython,
}, async (t) => {
  const source = fixture(t);
  run(
    `
from pathlib import Path
import sys, zipfile
p=Path(sys.argv[1])
w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
for name,prefix in [("ok",""),("bad","<!DOCTYPE aaa [<!ENTITY s 'blue'>]>")]:
 with zipfile.ZipFile(p/(name+".docx"),"w") as z:
  z.writestr("word/document.xml",prefix+f'<w:document xmlns:w="{w}"><w:body><w:p><w:r><w:t>'+'x'*5000+'</w:t></w:r></w:p></w:body></w:document>')
`,
    source.root,
  );
  const result = await readLocalSource(source, { maxChunks: 1 });
  assert.equal(result.chunks.length, 1);
  assert.equal(result.chunks[0].path, "ok.docx");
  assert.equal(result.truncated, true);
  assert.match(result.warnings.join(" "), /bad.docx/);
  assert.ok(result.chunks[0].text.length <= 1600);
});

test("offline Docling mode uses explicit external models; state policy cannot break plain text sync", async (t) => {
  const source = fixture(t);
  const models = join(source.temp, "models");
  mkdirSync(models);
  assert.deepEqual(
    doclingConfig(source.root, { mode: "scans", artifactsPath: models, languages: ["eng", "ara"] })
      .languages,
    ["eng", "ara"],
  );
  assert.throws(
    () => doclingConfig(source.root, { mode: "scans", artifactsPath: source.root }),
    /outside/,
  );
  assert.throws(
    () =>
      doclingConfig(source.root, { mode: "scans", artifactsPath: models, languages: ["--other"] }),
    /codes/,
  );
  writeFileSync(join(source.root, "readme.md"), "Healthy text source");
  writeFileSync(join(source.root, "bad.pdf"), "%PDF-1.2");
  const r = await readLocalSource({
    ...source,
    docling: { mode: "layout", artifactsPath: models },
  });
  assert.equal(r.chunks[0].text, "Healthy text source");
  assert.match(r.warnings.join(" "), /Docling|conversion/);
});

test("offline guard denies sockets to Python and its native subprocesses", {
  skip:
    process.platform !== "linux" ||
    !hasPython ||
    spawnSync(python, ["-I", "-c", "import ctypes; ctypes.CDLL('libseccomp.so.2')"]).status !== 0,
}, () => {
  const script = fileURLToPath(new URL("../src/source_docling.py", import.meta.url));
  run(
    `
import sys, subprocess, socket, runpy
runpy.run_path(sys.argv[1])["deny_linux_network"]()
try: socket.socket()
except PermissionError: pass
else: raise RuntimeError("network permitted")
assert subprocess.run([sys.executable,"-I","-c","import socket; socket.socket()"],capture_output=True).returncode != 0
`,
    script,
  );
});

test("an image-only PDF yields OCR text and a real page locator with the offline fallback", {
  skip:
    process.platform !== "linux" ||
    !hasPython ||
    spawnSync(python, ["-I", "-c", "import ctypes, PIL; ctypes.CDLL('libseccomp.so.2')"]).status !==
      0 ||
    ["pdfinfo", "pdftoppm", "pdftotext", "tesseract"].some(
      (cmd) => spawnSync(cmd, [cmd === "tesseract" ? "--version" : "-v"]).status !== 0,
    ),
}, async (t) => {
  const source = fixture(t);
  run(
    `
from PIL import Image,ImageDraw,ImageFont
from pathlib import Path
import sys
image=Image.new("RGB",(1100,500),"white")
draw=ImageDraw.Draw(image)
try:font=ImageFont.truetype("DejaVuSans.ttf",52)
except OSError:font=ImageFont.load_default(size=52)
draw.text((60,160),"Verify service invoices",fill="black",font=font)
image.save(Path(sys.argv[1])/"scan.pdf","PDF")
`,
    source.root,
  );
  const scan = await readLocalSource({
    ...source,
    docling: { mode: "scans" },
  });
  assert.deepEqual(scan.warnings, []);
  assert.equal(scan.chunks[0].structure.converter, "tesseract");
  assert.equal(scan.chunks[0].locator, "page 1");
  assert.match(scan.chunks[0].text, /service invoices/i);
});
