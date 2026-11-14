"""Atomic positive-price model reservations. Decimal nanodollars avoid float budget drift."""
import datetime
import json
import os
import sqlite3
import sys

os.umask(0o077)
p = json.load(sys.stdin)
day = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
with sqlite3.connect(p["file"], timeout=3, isolation_level=None) as db:
    db.execute("CREATE TABLE IF NOT EXISTS spend (id TEXT PRIMARY KEY, project TEXT NOT NULL, utc_day TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount >= 0), status TEXT NOT NULL)")
    db.execute("CREATE INDEX IF NOT EXISTS spend_project ON spend(project)")
    db.execute("CREATE INDEX IF NOT EXISTS spend_day ON spend(utc_day)")
    db.execute("BEGIN IMMEDIATE")
    daily = db.execute("SELECT coalesce(sum(amount),0) FROM spend WHERE utc_day=?", (day,)).fetchone()[0]
    project = db.execute("SELECT coalesce(sum(amount),0) FROM spend WHERE project=?", (p["project"],)).fetchone()[0]
    result = {}
    if p["op"] == "reserve":
        amount = p["amount"]
        if project + amount > p["projectLimit"]:
            result["reason"] = "project_spend_ceiling"
        elif daily + amount > p["dailyLimit"]:
            result["reason"] = "daily_spend_ceiling"
        else:
            db.execute("INSERT INTO spend VALUES (?,?,?,?,?)", (p["id"], p["project"], day, amount, "reserved"))
            result["reserved"] = True
    elif p["op"] == "settle":
        # A crash between dispatch and settlement leaves the full reservation charged.
        # Repeating a settlement is harmless only when the amount and verdict agree.
        row = db.execute("SELECT amount, status FROM spend WHERE id=? AND project=?", (p["id"], p["project"])).fetchone()
        if not row or (row[1] != "reserved" and row != (p["amount"], p["status"])):
            raise ValueError("No matching spend reservation")
        db.execute("UPDATE spend SET amount=?,status=? WHERE id=?", (p["amount"], p["status"], p["id"]))
    elif p["op"] == "summary":
        outstanding = db.execute("SELECT count(*) FROM spend WHERE project=? AND status='reserved'", (p["project"],)).fetchone()[0]
        result = {"utcDay": day, "dailyUsd": daily/1e9, "projectUsd": project/1e9, "outstanding":outstanding}
    else:
        raise ValueError("Invalid spend action")
    db.commit()
    print(json.dumps(result))
