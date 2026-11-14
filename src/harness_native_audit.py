"""A bounded audit of tool denials observed outside the supervised model loop."""
import json
import sqlite3
import sys
import time

db = sqlite3.connect(sys.argv[1], timeout=1)
db.row_factory = sqlite3.Row
with db:
    db.execute("CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, host TEXT, event TEXT, tool TEXT, reason TEXT)")
    db.execute("CREATE TABLE IF NOT EXISTS totals(host TEXT PRIMARY KEY, denied INTEGER NOT NULL)")
    request = json.load(sys.stdin)
    if request["op"] == "record":
        host = request["host"]
        cur = db.execute("INSERT INTO events(at,host,event,tool,reason) VALUES(?,?,?,?,?)",
                         (int(time.time() * 1000), host, request["event"], request["tool"], request["reason"]))
        db.execute("INSERT INTO totals VALUES(?,1) ON CONFLICT(host) DO UPDATE SET denied=denied+1", (host,))
        db.execute("DELETE FROM events WHERE id <= ?", (cur.lastrowid - 512,))
        result = {"recorded": True}
    else:
        events = [dict(r) for r in db.execute("SELECT * FROM events ORDER BY id DESC LIMIT 512")]
        totals = {r["host"]: r["denied"] for r in db.execute("SELECT * FROM totals")}
        result = {"denied": sum(totals.values()), "byHost": totals, "events": events}
db.close()
print(json.dumps(result))
