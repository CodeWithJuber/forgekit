"""Atomic per-tenant snapshot changes. Arguments and file names stay in SQLite values."""
import base64
import hashlib
import json
import os
import sqlite3
import sys
import time

os.umask(0o077)
db = sqlite3.connect(sys.argv[1], timeout=5)
db.execute("PRAGMA secure_delete=ON")
db.executescript("""
    CREATE TABLE IF NOT EXISTS deltas (scope TEXT, id TEXT, paths TEXT, PRIMARY KEY(scope,id));
    CREATE TABLE IF NOT EXISTS heads (scope TEXT PRIMARY KEY, revision TEXT);
    CREATE TABLE IF NOT EXISTS files (scope TEXT, path TEXT, hash TEXT, data BLOB,
        kind TEXT, redacted INTEGER, PRIMARY KEY(scope,path));
    CREATE TABLE IF NOT EXISTS changes (scope TEXT, id TEXT, parent TEXT, digest TEXT,
        created INTEGER, detail TEXT, PRIMARY KEY(scope,id));
""")
q = json.load(sys.stdin)
s = q["scope"]
op = q["op"]
db.execute("BEGIN IMMEDIATE" if op in ("push", "delete") else "BEGIN")
current = db.execute("SELECT revision FROM heads WHERE scope=?", (s,)).fetchone()
revision = current[0] if current else None
result = {"revision": revision}
if op == "status":
    result["files"] = [{"path": p, "sha256": h, "bytes": n, "kind": k, "redacted": bool(r)}
                       for p, h, n, k, r in db.execute(
            "SELECT path,hash,length(data),kind,redacted FROM files WHERE scope=? ORDER BY path",(s,))]
    result["events"] = [{"id": i, "at": t, **json.loads(d)} for i,t,d in db.execute(
        "SELECT id,created,detail FROM changes WHERE scope=? ORDER BY rowid DESC LIMIT 100",(s,))]
elif op == "events":
    if q.get("id"):
        item = db.execute("SELECT paths FROM deltas WHERE scope=? AND id=?", (s,q["id"])).fetchone()
        result = json.loads(item[0]) if item else {"error":404}
    else:
        start = db.execute("SELECT rowid FROM changes WHERE scope=? AND id=?",(s,q["after"])).fetchone() if q.get("after") else (0,)
        if not start:
            result = {"error":409}
        else:
            rows = list(db.execute("SELECT id,parent,created,detail FROM changes WHERE scope=? AND rowid>? ORDER BY rowid LIMIT 51",(s,start[0])))
            result = {"events":[{"id":i,"parent":p,"at":t,**json.loads(d)} for i,p,t,d in rows[:50]],
                      "hasMore":len(rows)>50, "next":rows[min(50,len(rows))-1][0] if rows else q.get("after")}
elif op == "artifact":
    row = db.execute("SELECT data,kind,hash FROM files WHERE scope=? AND path=?",(s,q["path"])).fetchone()
    result = {"content":base64.b64encode(row[0]).decode(), "kind":row[1], "sha256":row[2]} if row else {"error":404}
elif op == "delete":
    for table in ("changes","files","deltas"):
        db.execute(f"DELETE FROM {table} WHERE scope=?", (s,))
    # A fresh generation prevents stale in-flight and offline batches from recreating data.
    import uuid
    tombstone = str(uuid.uuid4())
    db.execute("INSERT OR REPLACE INTO heads VALUES(?,?)",(s,tombstone))
    result = {"deleted":True}
elif op == "push":
    change = q["change"]
    ident = change["id"]
    digest = hashlib.sha256(json.dumps(change,sort_keys=True,separators=(",",":")).encode()).hexdigest()
    seen = db.execute("SELECT digest FROM changes WHERE scope=? AND id=?", (s,ident)).fetchone()
    if seen:
        result = {"revision":ident, "replayed":True} if seen[0] == digest else {"error":409}
    elif revision != change["parent"]:
        result = {"error":409}
    else:
        for p in change["removed"]:
            db.execute("DELETE FROM files WHERE scope=? AND path=?", (s,p))
        for f in change["files"]:
            db.execute("INSERT OR REPLACE INTO files VALUES(?,?,?,?,?,?)",
                       (s,f["path"],f["sha256"],base64.b64decode(f["content"],validate=True),
                        f["kind"],int(f["redacted"])))
        count,size = db.execute("SELECT count(*),coalesce(sum(length(data)),0) FROM files WHERE scope=?",(s,)).fetchone()
        if count > 20000 or size > 128*1024*1024:
            db.rollback()
            result = {"error":413}
        else:
            db.execute("INSERT OR REPLACE INTO heads VALUES(?,?)",(s,ident))
            detail = json.dumps({"modified":len(change["files"]),"removed":len(change["removed"])})
            db.execute("INSERT INTO changes VALUES(?,?,?,?,?,?)",(s,ident,revision,digest,int(time.time()*1000),detail))
            paths = {"id":ident, "updated":[{"path":f["path"],"sha256":f["sha256"]} for f in change["files"]],
                     "removed":change["removed"]}
            db.execute("INSERT INTO deltas VALUES (?,?,?)",(s,ident,json.dumps(paths,separators=(",",":"))))
            result = {"revision":ident}
else:
    raise ValueError("Unknown operation")
db.commit()
print(json.dumps(result,separators=(",",":")))
