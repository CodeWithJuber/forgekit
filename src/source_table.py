"""Bounded local table reader. Receives bytes on stdin; it never opens a user-supplied path."""
import csv
import io
import json
import re
import sys
import zipfile
from decimal import Decimal, localcontext
from fractions import Fraction

MAX_ROWS, MAX_COLS, MAX_GROUPS = 100_000, 256, 1_000


class TableError(ValueError):
    pass


def sheets(data, ext):
    if ext in (".csv", ".tsv"):
        encoding = "utf-16" if data.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig"
        stream = io.TextIOWrapper(io.BytesIO(data), encoding=encoding, newline="")
        delimiter = "\t" if ext == ".tsv" else ","
        yield None, csv.reader(stream, delimiter=delimiter, strict=True)
        return
    if ext == ".xls":
        import xlrd
        book = xlrd.open_workbook(file_contents=data, on_demand=True, logfile=io.StringIO())
        try:
            for name in book.sheet_names():
                sheet = book.sheet_by_name(name)
                if not getattr(sheet, "visibility", 0):
                    if sheet.ncols > MAX_COLS:
                        raise TableError("table exceeds column limit")
                    yield name, (sheet.row_values(i) for i in range(sheet.nrows))
                book.unload_sheet(name)
        finally:
            book.release_resources()
        return
    import openpyxl
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        if len(entries) > 4096 or sum(e.file_size for e in entries) > 64 * 1024**2:
            raise TableError("workbook exceeds expansion limit")
        # openpyxl may use different XML parsers depending on the local environment.
        # Refuse DTD/entity declarations before handing it untrusted workbook XML.
        for entry in entries:
            if entry.filename.lower().endswith((".xml", ".rels")):
                xml = archive.read(entry).replace(b"\x00", b"").upper()
                if b"<!DOCTYPE" in xml or b"<!ENTITY" in xml:
                    raise TableError("workbook contains unsupported XML declarations")
    book = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=False, keep_links=False)
    try:
        for sheet in book.worksheets:
            if sheet.sheet_state == "visible":
                # Ignore inaccurate producer-written worksheet bounds when counting records.
                sheet.reset_dimensions()
                yield sheet.title, sheet.values
    finally:
        book.close()


def row_values(row):
    if len(row) > MAX_COLS:
        raise TableError("table exceeds column limit")
    cells = ["" if value is None else str(value) for value in row]
    if any("-----BEGIN " in c.upper() for c in cells):
        raise TableError("sensitive table content skipped")
    return cells


# Keep token/cost telemetry queryable ("input_tokens", "token_count") while masking
# known credential columns. Header matching tolerates spaces, snake_case and camelCase.
SECRET_HEADER = re.compile(
    r"(?:password|passwd|secret|credentials?|apikey|authorization|"
    r"(?:access|refresh|auth|session|bearer|api|private|personalaccess|github|gitlab)token)$"
)


def credential_column(label):
    normalized = re.sub(r"[^a-z0-9]", "", label.lower())
    return normalized == "token" or SECRET_HEADER.search(normalized) is not None


def index(sheets_iter, limit):
    chunks = []
    structure = []
    truncated = False
    def emit(name, start, end, lines):
        loc = f"rows {start}-{end}" if start != end else f"row {start}"
        if name is not None:
            loc = f"{name} / {loc}"
        chunks.append({"locator": loc, "text": "\n".join(lines)})

    for name, rows in sheets_iter:
        first = next(rows, None)
        meta = {"sheet": name, "indexedRows": 0, "columnCount": 0, "columns": []}
        if len(structure) < 32:
            structure.append(meta)
        if first is None:
            continue
        header = row_values(first)
        meta.update(columnCount=len(header), columns=[c[:120] for c in header[:32]])
        masked = [i for i, key in enumerate(header) if credential_column(key)]
        start = end = 1
        header_text = "Columns: " + json.dumps(header, ensure_ascii=False)
        lines = [header_text[:800]]
        truncated |= len(header_text) > 800
        for end, row in enumerate(rows, 2):
            if end > MAX_ROWS + 1:
                truncated = True
                end -= 1
                break
            meta["indexedRows"] = end - 1
            cells = row_values(row)
            for i in masked:
                if i < len(cells):
                    cells[i] = "[REDACTED]"
            line = f"{end} " + json.dumps(cells, ensure_ascii=False)
            if len(lines) > 1 and (len(lines) >= 16 or sum(map(len, lines)) + len(line) > 1500):
                emit(name, start, end - 1, lines)
                if len(chunks) >= limit:
                    return {"chunks": chunks, "truncated": True, "structure": {"sheets": structure}}
                start = end
                lines = [header_text[:800]]
            truncated |= len(line) > 1000
            lines.append(line[:1000])
        if len(chunks) >= limit:
            return {"chunks": chunks, "truncated": True, "structure": {"sheets": structure}}
        emit(name, start, end, lines)
    return {"chunks": chunks, "truncated": truncated, "structure": {"sheets": structure}}


def exact_number(raw):
    text = raw.strip()
    if not re.fullmatch(r"[+-]?(?:\d{1,60}(?:\.\d{0,60})?|\.\d{1,60})(?:[eE][+-]?\d{1,3})?", text):
        raise TableError("numeric aggregate encountered a non-numeric value")
    dec = Decimal(text)
    if abs(dec.as_tuple().exponent) > 120 or dec.adjusted() > 120:
        raise TableError("number exceeds supported decimal range")
    return Fraction(dec)


def decimal_text(value, average):
    with localcontext() as ctx:
        # Finite input exponents span 240 positions, at most 10^5 rows.
        # Average is explicitly rounded to 34 significant digits.
        ctx.prec = 34 if average else 320
        result = format(Decimal(value.numerator) / Decimal(value.denominator), "f")
    return result.rstrip("0").rstrip(".") if "." in result else result


def aggregate(sheets_iter, opts):
    op, column = opts["operation"], opts.get("column")
    selected, group_by = opts.get("sheet"), opts.get("groupBy")
    if op not in ("count", "sum", "min", "max", "avg"):
        raise TableError("unknown aggregate operation")
    if op != "count" and not column:
        raise TableError("numeric aggregate requires column")
    result = None
    for name, rows in sheets_iter:
        if selected is not None and selected != name:
            continue
        if result is not None:
            raise TableError("multiple sheets: select a sheet explicitly")
        header = [c.strip() for c in row_values(next(rows, []))]
        if not header:
            raise TableError("table has no header row")
        for key in [column, group_by]:
            if key is not None and credential_column(key):
                raise TableError("sensitive credential column cannot be selected")
            if key is not None and (not key or header.count(key) != 1):
                raise TableError("requested column is missing or ambiguous")
        col = header.index(column) if column else None
        grp = header.index(group_by) if group_by else None
        groups = {} if group_by else {None: [0, None]}
        scanned = 0
        for row_number, row in enumerate(rows, 2):
            if row_number > MAX_ROWS + 1:
                raise TableError("table exceeds row limit; no partial aggregate")
            cells = row_values(row)
            if not any(cells):
                continue
            if len(cells) > len(header) and any(cells[len(header):]):
                raise TableError("table row contains data beyond header")
            cells.extend([""] * (len(header) - len(cells)))
            scanned += 1
            group = cells[grp] if grp is not None else None
            if group not in groups:
                if len(groups) >= MAX_GROUPS:
                    raise TableError("table exceeds group limit")
                groups[group] = [0, None]
            count, value = groups[group]
            if col is not None and not cells[col].strip():
                continue
            if op != "count":
                num = exact_number(cells[col])
                if value is None:
                    value = num
                elif op == "min":
                    value = min(num, value)
                elif op == "max":
                    value = max(num, value)
                else:
                    value += num
            groups[group] = [count + 1, value]
        results = []
        for group, (count, value) in groups.items():
            if op == "count":
                value = count
            elif value is not None:
                value = decimal_text(value / count if op == "avg" else value, op == "avg")
            results.append({"group": group, "value": value, "count": count})
        result = {"sheet": name, "operation": op, "column": column, "groupBy": group_by,
                  "groups": results, "rowsScanned": scanned}
    if result is None:
        raise TableError("sheet not found")
    return result


def relational(sheets_iter, selected):
    result = None
    for name, rows in sheets_iter:
        if selected is not None and selected != name:
            continue
        if result is not None:
            raise TableError("multiple sheets: select a sheet explicitly")
        header = [str(c).strip() for c in row_values(next(rows, []))]
        if not header or len(header) > 80 or any(not c or len(c) > 128 or any(ord(ch) < 32 for ch in c) for c in header):
            raise TableError("expected up to 80 nonempty, bounded column headers")
        if len(set(c.lower() for c in header)) != len(header):
            raise TableError("ambiguous duplicate column headers")
        visible = [i for i,c in enumerate(header) if not credential_column(c)]
        if not visible:
            raise TableError("table has no selectable columns")
        result = {"sheet":name, "columns":[header[i] for i in visible], "rows":[]}
        size = 0
        for n,row in enumerate(rows, 1):
            if n > MAX_ROWS:
                raise TableError("table exceeds row limit")
            cells = row_values(row)
            if not any(cells):
                continue
            if len(cells) > len(header) and any(cells[len(header):]):
                raise TableError("table row exceeds header")
            values = [cells[i] if i < len(cells) and cells[i] != "" else None for i in visible]
            size += sum(len(v.encode()) if v else 0 for v in values) + 5 * len(values)
            if size > 2 * 1024**2:
                raise TableError("table exceeds in-memory SQL data limit")
            result["rows"].append(values)
    if result is None:
        raise TableError("sheet not found")
    return result


def main():
    mode, ext, settings = sys.argv[1:]
    opts = json.loads(settings)
    if sys.platform.startswith("linux"):
        import resource
        ceiling = 768 * 1024**2
        _, hard = resource.getrlimit(resource.RLIMIT_AS)
        ceiling = ceiling if hard < 0 else min(ceiling, hard)
        resource.setrlimit(resource.RLIMIT_AS, (ceiling, ceiling))
    data = sys.stdin.buffer.read(8 * 1024**2 + 1)
    if len(data) > 8 * 1024**2:
        raise TableError("file exceeds byte limit")
    tables = sheets(data, ext)
    try:
        if mode == "index":
            result = index(tables, opts["limit"])
        elif mode == "relational":
            result = relational(tables, opts.get("sheet"))
        else:
            result = aggregate(tables, opts)
    finally:
        tables.close()
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    try:
        main()
    except ModuleNotFoundError as exc:
        print(json.dumps({"error": "install the optional Python package " + str(exc.name)}))
    except TableError as exc:
        print(json.dumps({"error": str(exc)}))
    except Exception as exc:
        # Exception messages from parsers can contain raw confidential cell content.
        print(json.dumps({"error": "invalid or unsupported table (" + type(exc).__name__ + ")"}))
