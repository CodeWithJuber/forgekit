"""Export only a named workspace's rows from ForgeKit's shared memory database."""
import json
import pathlib
import sqlite3
import sys

db = sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri() + "?mode=ro", uri=True)
db.row_factory = sqlite3.Row
db.execute("PRAGMA query_only=ON")
db.execute("PRAGMA trusted_schema=OFF")
db.execute("BEGIN")
scope = sys.argv[2]
result = {}
limits = 0
tables = {"memory": (("observations", "repo"), ("items", "scope"), ("ledger", "scope"),
                   ("edges", "scope"), ("finished", "repo"), ("sources", "repo"),
                   ("leaves", "repo"), ("nodes", "repo")),
          "jobs": tuple((t,None) for t in ("jobs","events","schedules","job_cost","class_pauses","trigger_events","decisions","group_inputs","council_records")),
          "audit": (("events",None),("totals",None)), "spending": (("spend","project"),)}
for table, key in tables[sys.argv[3]]:
    row = db.execute("SELECT type,sql FROM sqlite_master WHERE name=?", (table,)).fetchone()
    if not row:
        continue
    if row["type"] != "table" or row["sql"].upper().startswith("CREATE VIRTUAL"):
        raise ValueError("Unexpected memory schema")
    result[table] = []
    where = f" WHERE {key}=?" if key else ""
    for item in db.execute(f"SELECT * FROM {table}{where} ORDER BY rowid",(scope,) if key else ()) :
        fields = dict(item)
        if table == "jobs":
            fields.pop("token",None)
        limits += len(json.dumps(fields).encode())
        if limits > 24*1024*1024:
            raise ValueError("Memory export exceeds 24 MiB")
        result[table].append(fields)
print(json.dumps(result, ensure_ascii=False, separators=(",",":")))
