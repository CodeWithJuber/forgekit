"""Read-only, bounded SQL over ForgeKit-generated snapshot tables. No extensions or file SQL."""
from fractions import Fraction
import importlib.util
import json
import os
import re
import sqlite3
import sys
import time
from pathlib import Path

MAX_ROWS = 1000
MAX_RESULT = 128 * 1024
TABLES = {"items", "chunks"}
FUNCTIONS = set("count sum avg min max total round abs lower upper length substr substring coalesce ifnull nullif date datetime strftime julianday unixepoch like decimal_sum decimal_avg".split())

def build(db, payload):
    db.executescript("""
        CREATE TABLE items(id TEXT PRIMARY KEY, path TEXT, title TEXT, kind TEXT, status TEXT,
          updated_at TEXT, fetched_at TEXT, source TEXT, chunk_count INTEGER);
        CREATE TABLE chunks(item_id TEXT, ordinal INTEGER, locator TEXT, text TEXT,
          PRIMARY KEY(item_id, ordinal));
    """)
    db.executemany("INSERT INTO items VALUES (?,?,?,?,?,?,?,?,?)", payload["items"])
    db.executemany("INSERT INTO chunks VALUES (?,?,?,?)", payload["chunks"])
    db.commit()

def table_data(db, tables):
    allowed = set()
    # Schema identifiers are independently quoted. User SQL cannot supply a path,
    # CREATE statement, dump or extension. User-controlled values are bound.
    def quote(s):
        return '"' + s.replace('"', '""') + '"'
    for table in tables:
        name, columns = table["name"], table["columns"]
        if not re.fullmatch(r"[a-z][a-z0-9_]{0,39}",name) or name.startswith("sqlite_") or name in allowed:
            raise ValueError("invalid table name")
        quoted = ",".join(quote(c)+" TEXT" for c in columns)
        db.execute("CREATE TABLE " + quote(name) + " (" + quoted + ")")
        db.executemany("INSERT INTO " + quote(name) + " VALUES (" + ",".join("?" for _ in columns) + ")", table["rows"])
        allowed.add(name)
    db.commit()
    return allowed

# -I omits the script directory from sys.path. Load only the installed sibling
# table parser, using the same decimal grammar, bounds and rounding as aggregate().
spec = importlib.util.spec_from_file_location("forge_source_table", Path(__file__).with_name("source_table.py"))
table_math = importlib.util.module_from_spec(spec)
spec.loader.exec_module(table_math)

class DecimalSum:
    average = False
    def __init__(self):
        self.total, self.count = Fraction(), 0
    def step(self, value):
        if value is None:
            return
        if not isinstance(value,str):
            raise ValueError("expected a decimal text column")
        self.total += table_math.exact_number(value)
        self.count += 1
    def finalize(self):
        if not self.count:
            return None
        value = self.total/self.count if self.average else self.total
        return table_math.decimal_text(value, self.average)

class DecimalAvg(DecimalSum):
    average = True

def select(db, sql, allowed=TABLES):
    if not isinstance(sql, str) or len(sql) > 8192 or "\x00" in sql:
        raise ValueError("Expected a SELECT query up to 8192 characters")
    sql = sql.strip().removesuffix(";").rstrip()
    if not re.match(r"^(select|with)\b", sql, re.I):
        raise ValueError("Only SELECT queries are accepted")
    db.execute("PRAGMA hard_heap_limit=67108864")
    db.execute("PRAGMA trusted_schema=OFF")
    db.execute("PRAGMA temp_store=MEMORY")
    db.execute("PRAGMA query_only=ON")
    if hasattr(db, "setlimit"):
        for code, value in [(sqlite3.SQLITE_LIMIT_LENGTH, 262144), (sqlite3.SQLITE_LIMIT_COLUMN, 80),
                            (sqlite3.SQLITE_LIMIT_EXPR_DEPTH, 50), (sqlite3.SQLITE_LIMIT_COMPOUND_SELECT, 12)]:
            db.setlimit(code, value)
    def authorize(op, arg1, arg2, database, trigger):
        if op == sqlite3.SQLITE_SELECT:
            return sqlite3.SQLITE_OK
        if op == sqlite3.SQLITE_READ and arg1 in allowed and database in ("main", None):
            return sqlite3.SQLITE_OK
        if op == sqlite3.SQLITE_FUNCTION and arg2 and arg2.lower() in FUNCTIONS:
            return sqlite3.SQLITE_OK
        return sqlite3.SQLITE_DENY
    db.create_aggregate("decimal_sum", 1, DecimalSum)
    db.create_aggregate("decimal_avg", 1, DecimalAvg)
    db.set_authorizer(authorize)
    deadline = time.monotonic() + 1.5
    db.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
    cursor = db.execute("SELECT * FROM (" + sql + "\n) LIMIT 1001")
    columns = [col[0] for col in cursor.description]
    size = len(json.dumps(columns).encode())
    rows = []
    if len(columns) > 80:
        raise ValueError("Too many result columns")
    for row in cursor:
        if any(isinstance(v, bytes) for v in row):
            raise ValueError("Binary SQL results are unsupported")
        size += len(json.dumps(row, ensure_ascii=True, allow_nan=False).encode()) + 1
        if len(rows) == MAX_ROWS or size > MAX_RESULT:
            return {"columns": columns, "rows": rows, "truncated": True}
        rows.append(row)
    return {"columns": columns, "rows": rows, "truncated": False}

def main():
    os.umask(0o077)
    mode = sys.argv[1]
    payload = json.load(sys.stdin)
    if mode == "build":
        db = sqlite3.connect(sys.argv[2])
        try:
            build(db, payload)
        finally:
            db.close()
        return {"ok": True}
    db = sqlite3.connect(":memory:" if mode in ("memory","table_data") else Path(sys.argv[2]).as_uri() + "?mode=ro&immutable=1", uri=True)
    try:
        if mode == "memory":
            build(db, payload)
        allowed = table_data(db,payload["tables"]) if mode == "table_data" else TABLES
        return select(db, payload["sql"], allowed)
    finally:
        db.close()

if __name__ == "__main__":
    try:
        print(json.dumps(main(), allow_nan=False))
    except (ValueError, sqlite3.Error, OverflowError) as exc:
        # SQL errors may echo source text or query literals. Return a bounded generic reason.
        print(json.dumps({"error": "Invalid, disallowed or over-budget mirror query", "category": type(exc).__name__}))
