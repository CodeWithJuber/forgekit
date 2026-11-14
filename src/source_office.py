"""Read bounded OOXML document parts from stdin. No relationships are dereferenced."""
import io
import json
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

MAX_PARTS = 4096
MAX_BYTES = 48 * 1024**2
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
P = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


def xml(archive, path):
    data = archive.read(path)
    # ElementTree does not resolve external entities. Reject DTDs, including
    # UTF-16 and UTF-32 input, to avoid entity expansion inside a trusted parser.
    if re.search(br"<!\s*(?:DOCTYPE|ENTITY)\b", data.replace(b"\0", b""), re.I):
        raise ValueError()
    return ET.fromstring(data)


def docx(archive):
    body = xml(archive, "word/document.xml").find(W + "body")
    if body is None:
        raise ValueError()
    out = []
    paragraph, tables = 0, 0
    for element in body:
        if element.tag == W + "p":
            paragraph += 1
            text = "".join(node.text or "" for node in element.iter(W + "t"))
            out.append([f"paragraph {paragraph}", text])
        elif element.tag == W + "tbl":
            tables += 1
            for i, row in enumerate(element.findall(W + "tr"), 1):
                cells = [" ".join("".join(n.text or "" for n in p.iter(W+"t")) for p in c.findall(W+"p")) for c in row.findall(W+"tc")]
                out.append([f"table {tables} / row {i}", " | ".join(cells)])
        if len(out) > 100000:
            raise ValueError()
    return out, {"paragraphs": paragraph, "tables": tables}


def pptx(archive):
    pres = xml(archive, "ppt/presentation.xml")
    rels = {e.get("Id"): e.get("Target") for e in xml(archive, "ppt/_rels/presentation.xml.rels")
            if not e.get("TargetMode") and (e.get("Type") or "").endswith("/slide")}
    out = []
    order = pres.findall(P+"sldIdLst/"+P+"sldId")
    if len(order) > 2000:
        raise ValueError()
    for i, slide in enumerate(order, 1):
        target = rels.get(slide.get(R+"id"))
        # Accept the two standard internal slide paths; never unpack the archive.
        if not isinstance(target, str) or not re.fullmatch(r"(?:/ppt/)?slides/slide[0-9]+\.xml", target):
            raise ValueError()
        root = xml(archive, target.lstrip("/") if target.startswith("/") else "ppt/"+target)
        if root.get("show") in ("0", "false"):
            continue
        lines = ["".join(n.text or "" for n in p.iter(A+"t")) for p in root.iter(A+"p")]
        out.append([f"slide {i}", "\n".join(lines)])
    return out, {"slides":len(order), "visibleSlides":len(out)}


def main():
    data = sys.stdin.buffer.read(8 * 1024**2 + 1)
    if len(data) > 8 * 1024**2:
        raise ValueError()
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        if (len(entries) > MAX_PARTS or sum(a.file_size for a in entries) > MAX_BYTES
                or len({a.filename for a in entries}) != len(entries)):
            raise ValueError()
        sections, structure = docx(archive) if sys.argv[1] == ".docx" else pptx(archive)
    # Reject sensitive multi-section private keys; the node caller handles single
    # credentials in ordinary text and never receives the unredacted PEM body.
    if "-----BEGIN " in "".join(text.upper() for _, text in sections):
        raise ValueError()
    if sum(len(t) for _, t in sections) > 2 * 1024**2:
        raise ValueError()
    print(json.dumps({"sections":sections, "structure":structure}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(json.dumps({"error":"Office file is unsupported, sensitive, corrupt or exceeds limits"}))
