"""Transactional queue backing the Node 20 CLI. No provider or tool execution lives here."""
import bisect
import datetime as dt
import hashlib
import json
import os
import sqlite3
import sys
import uuid

os.umask(0o077)
db = sqlite3.connect(os.path.join(sys.argv[1], "jobs.sqlite3"), timeout=8, isolation_level=None)
db.row_factory = sqlite3.Row
db.executescript("""
CREATE TABLE IF NOT EXISTS jobs (
 id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, request TEXT NOT NULL, priority INTEGER NOT NULL,
 created INTEGER NOT NULL, available INTEGER NOT NULL, state TEXT NOT NULL, attempts INTEGER DEFAULT 0,
 max_attempts INTEGER NOT NULL, token TEXT, lease INTEGER, started INTEGER DEFAULT 0, result TEXT, approval TEXT);
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(state, available, priority, created);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, job TEXT, at INTEGER, event TEXT, detail TEXT);
CREATE INDEX IF NOT EXISTS events_by_job ON events(job,id);
CREATE TABLE IF NOT EXISTS schedules(name TEXT PRIMARY KEY, revision TEXT NOT NULL, cursor INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS job_cost(job TEXT PRIMARY KEY, amount REAL NOT NULL, verified INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS class_pauses(priority INTEGER PRIMARY KEY, until_ms INTEGER, why TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS trigger_events(name TEXT, at INTEGER);
CREATE INDEX IF NOT EXISTS trigger_time ON trigger_events(at);
CREATE TABLE IF NOT EXISTS decisions(id INTEGER PRIMARY KEY, shape TEXT NOT NULL, hash TEXT NOT NULL,
 at INTEGER NOT NULL, value TEXT NOT NULL, UNIQUE(shape,hash));
CREATE TABLE IF NOT EXISTS group_inputs(key TEXT PRIMARY KEY, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS council_records(key TEXT PRIMARY KEY, value TEXT NOT NULL);
""")
def encode(x):
    return json.dumps(x, ensure_ascii=False, sort_keys=True, separators=(",", ":"))

def event(job, now, kind, detail=None):
    db.execute("INSERT INTO events(job,at,event,detail) VALUES (?,?,?,?)", (job,now,kind,encode(detail)))

def lookup(jid):
    return db.execute("SELECT * FROM jobs WHERE id=?", (jid,)).fetchone()

def public(j):
    if j is None:
        return None
    return {"id":j["id"],"key":j["key"],"priority":"P"+str(j["priority"]),"state":j["state"],
            "attempts":j["attempts"],"maxAttempts":j["max_attempts"],"availableAt":j["available"],
            "result":j["result"],"approval":json.loads(j["approval"]) if j["approval"] else None}

def enqueue(j, now):
    existing = db.execute("SELECT * FROM jobs WHERE key=?", (j["key"],)).fetchone()
    request = encode(j["request"])
    if existing:
        if existing["request"] != request or existing["max_attempts"] != j["maxAttempts"]:
            raise ValueError("Idempotency key already belongs to different work")
        return public(existing)
    jid = str(uuid.uuid4())
    db.execute("""INSERT INTO jobs(id,key,request,priority,created,available,state,max_attempts)
      VALUES(?,?,?,?,?,?,'queued',?)""",(jid,j["key"],request,j["priority"],now,j["availableAt"],j["maxAttempts"]))
    event(jid,now,"enqueued")
    return public(lookup(jid))

def claim(d):
    now = d["now"]
    for row in db.execute("SELECT * FROM jobs WHERE state='running' AND lease <= ?",(now,)).fetchall():
        state = "dead_letter" if row["attempts"] >= row["max_attempts"] else "queued"
        db.execute("UPDATE jobs SET state=?,token=NULL,lease=NULL,available=?,result='lease_expired' WHERE id=?",
                   (state,now,row["id"]))
        event(row["id"],now,"lease_expired",{"state":state})
    j = db.execute("""SELECT * FROM jobs WHERE state='queued' AND available <= ?
        AND NOT EXISTS (SELECT 1 FROM class_pauses p WHERE p.priority=jobs.priority
        AND (p.until_ms IS NULL OR p.until_ms>?))
        ORDER BY CASE WHEN priority=3 AND created <= ? THEN 2 ELSE priority END,
        created,rowid LIMIT 1""",(now,now,now-86400000)).fetchone()
    if j is None:
        return None
    db.execute("""UPDATE jobs SET state='running', started=1, attempts=attempts+1,
       token=?,lease=? WHERE id=?""",(d["token"],now+d["leaseMs"],j["id"]))
    event(j["id"],now,"leased",{"attempt":j["attempts"]+1})
    return {"id":j["id"],"resume":bool(j["started"]),"request":json.loads(j["request"])}

def finish(d):
    j = lookup(d["id"])
    if not j or j["state"]!="running" or j["token"]!=d["token"] or j["lease"]<=d["now"]:
        raise ValueError("Expired lease; a stale worker cannot acknowledge a run")
    status=d["status"]
    amount=d.get("amount")
    if amount is not None:
        # The loop's usage is cumulative across resumption. Charge a run once.
        db.execute("""INSERT INTO job_cost VALUES (?,?,?) ON CONFLICT(job) DO UPDATE SET
            amount=MAX(job_cost.amount,excluded.amount),verified=MAX(job_cost.verified,excluded.verified)""",
            (j["id"],amount,1 if d.get("verified") else 0))
    available=d["now"]
    if status=="approval_pending":
        state="awaiting_approval"
    elif status=="budget_exhausted" and d["reason"] in ("daily_spend_ceiling","project_spend_ceiling"):
        until=(d["now"]//86400000+1)*86400000 if d["reason"]=="daily_spend_ceiling" else None
        state="queued" if until else "budget_paused"
        if until: available=until
        db.execute("INSERT OR REPLACE INTO class_pauses VALUES(?,?,?)",(j["priority"],until,d["reason"]))
        event(j["id"],d["now"],"class_paused",{"owner":json.loads(j["request"]).get("actor","local"),"priority":"P"+str(j["priority"]),"until":until})
    elif status=="done":
        state="done"
    elif status in ("dispatch_error","provider_failed") and j["attempts"]<j["max_attempts"]:
        state="queued"
        available += 1000 * (2 ** (j["attempts"]-1))
    else:
        state="dead_letter"
    db.execute("UPDATE jobs SET state=?,result=?,approval=?,available=?,lease=NULL,token=NULL WHERE id=?",
               (state,d["reason"],encode(d["approval"]),available,d["id"]))
    event(d["id"],d["now"],"settled",{"state":state,"reason":d["reason"],"runStatus":status})
    return public(lookup(d["id"]))

def field(s, low, high):
    result=set()
    for part in s.split(","):
        pieces=part.split("/")
        if len(pieces)>2: raise ValueError("Invalid cron step")
        span=pieces[0]
        step=int(pieces[1]) if len(pieces)==2 else 1
        if span=="*": a,b=low,high
        elif "-" in span: a,b=map(int,span.split("-"))
        else:
            a=int(span)
            b=a if len(pieces)==1 else high
        if step<1 or not low<=a<=b<=high: raise ValueError("Cron value out of range")
        result.update(range(a,b+1,step))
    return result

def cron_matches(expression,start,end,limit):
    parts=expression.split()
    if len(parts)!=5: raise ValueError("Schedules require five UTC cron fields")
    minute,hour,dom,month,dow=[field(s,*bounds) for s,bounds in zip(parts,[(0,59),(0,23),(1,31),(1,12),(0,7)])]
    if 7 in dow: dow.add(0)
    # Walk days instead of every past minute. Recover the newest bounded backlog.
    times=sorted(h*60+m for h in hour for m in minute)
    hits=[]
    for day in range(end//1440,max(start//1440-1,-1),-1):
        date=dt.date(1970,1,1)+dt.timedelta(days=day)
        match_day=date.day in dom
        match_week=(date.weekday()+1)%7 in dow
        day_ok=(match_day and match_week) if parts[2].startswith("*") or parts[4].startswith("*") else (match_day or match_week)
        if date.month not in month or not day_ok: continue
        base=day*1440
        a=bisect.bisect_left(times,start-base)
        b=bisect.bisect_right(times,end-base)
        for i in range(b-1,a-1,-1):
            hits.append(base+times[i])
            if len(hits)==limit: return hits
    return hits

def tick(d):
    minute=d["now"]//60000
    result=[]
    for s in d["schedules"]:
        fingerprint=hashlib.sha256(encode(s).encode()).hexdigest()
        row=db.execute("SELECT * FROM schedules WHERE name=?",(s["name"],)).fetchone()
        cursor=row["cursor"] if row and row["revision"]==fingerprint else minute-1
        if cursor>=minute: continue
        # Skip/rate-limit recovery older than the supported five-year horizon.
        start=max(0,cursor+1,minute-5*366*1440)
        if s["missed"]=="skip" or not s["enabled"]: start=minute
        cap=16 if s["missed"]=="catch_up" else 1
        slots=cron_matches(s["cron"],start,minute,cap+1)
        if s["enabled"]:
            for slot in reversed(slots[:cap]):
                j={**s["job"],"key":"cron:"+s["name"]+":"+str(slot)}
                job=enqueue(j,d["now"])
                if len(slots)>cap: event(job["id"],d["now"],"backlog_coalesced",{"policy":s["missed"],"limit":cap})
                result.append(job)
        db.execute("INSERT OR REPLACE INTO schedules VALUES (?,?,?)",(s["name"],fingerprint,minute))
    return result

def operation(op,d):
    if op=="enqueue": return enqueue(d["job"],d["now"])
    if op=="tick": return tick(d)
    if op=="claim": return claim(d)
    if op=="finish": return finish(d)
    if op=="lookup": return public(lookup(d["id"]))
    if op=="list":
        return [public(r) for r in db.execute("SELECT * FROM jobs ORDER BY created DESC,rowid DESC LIMIT ?",(d["limit"],))]
    if op=="metrics":
        entries=[dict(r) for r in db.execute("""SELECT j.priority AS priorityClass,j.state,COUNT(*) AS jobs
            FROM jobs j GROUP BY j.priority,j.state ORDER BY j.priority,j.state""")]
        rows=db.execute("""SELECT COUNT(*) AS total, COUNT(c.job) AS accounted,
            COALESCE(SUM(c.amount),0) AS spend, COALESCE(SUM(c.verified),0) AS verified
            FROM jobs j LEFT JOIN job_cost c ON c.job=j.id WHERE j.state IN ('done','dead_letter')""").fetchone()
        ratio=rows['spend']/rows['verified'] if rows['verified'] and rows['total']==rows['accounted'] else None
        return {"byClassAndState":entries,"completedOrFailed":rows["total"],"withCostReceipts":rows["accounted"],
                "verifiedTasks":rows["verified"],"accountedSpendUsd":rows["spend"],"costPerVerifiedTaskUsd":ratio}
    if op=="history":
        return [dict(r) for r in db.execute("SELECT at,event,detail FROM events WHERE job=? ORDER BY id DESC LIMIT 200",(d["id"],))]
    if op=="pulse":
        return bool(db.execute("""UPDATE jobs SET lease=? WHERE id=? AND state='running' AND token=? AND lease>?""",
          (d["now"]+d["leaseMs"],d["id"],d["token"],d["now"])).rowcount)
    if op=="release":
        j=lookup(d["id"])
        if j and j["state"]=="budget_paused":
            db.execute("DELETE FROM class_pauses WHERE priority=?",(j["priority"],))
        changed=db.execute("""UPDATE jobs SET state='queued',available=?,attempts=0 WHERE id=? AND state IN ('awaiting_approval','budget_paused')""",
                           (d["now"],d["id"])).rowcount
        if not changed: raise ValueError("Only an approval or project-budget pause can be reconsidered")
        event(d["id"],d["now"],"operator_released")
        return public(lookup(d["id"]))
    if op=="trigger":
        existing=db.execute("SELECT 1 FROM jobs WHERE key=?",(d["job"]["key"],)).fetchone()
        if not existing:
            db.execute("DELETE FROM trigger_events WHERE at <= ?",(d["now"]-60000,))
            count=db.execute("SELECT COUNT(*) FROM trigger_events WHERE name=?",(d["name"],)).fetchone()[0]
            if count>=d["limit"]: raise ValueError("Trigger rate limit exceeded")
            db.execute("INSERT INTO trigger_events VALUES (?,?)",(d["name"],d["now"]))
        return enqueue(d["job"],d["now"])
    if op=="trial":
        v=encode(d["value"])
        existing=db.execute("SELECT value FROM decisions WHERE shape=? AND hash=?",(d["shape"],d["hash"])).fetchone()
        if existing and existing["value"]!=v: raise ValueError("Frozen trial already has a different recorded outcome")
        db.execute("INSERT OR IGNORE INTO decisions(shape,hash,at,value) VALUES (?,?,?,?)",(d["shape"],d["hash"],d["now"],v))
        return d["value"]
    if op=="decision":
        row=db.execute("SELECT value FROM decisions WHERE shape=? ORDER BY id DESC LIMIT 1",(d["shape"],)).fetchone()
        return json.loads(row["value"]) if row else None
    if op=="bind_group":
        existing=db.execute("SELECT hash FROM group_inputs WHERE key=?", (d["key"],)).fetchone()
        if existing and existing[0]!=d["hash"]:
            raise ValueError("Decision ID conflict: immutable delegation contract changed")
        db.execute("INSERT OR IGNORE INTO group_inputs VALUES (?,?)",(d["key"],d["hash"]))
        return True
    if op=="council":
        v=encode(d["value"])
        row=db.execute("SELECT value FROM council_records WHERE key=?",(d["key"],)).fetchone()
        if row and row["value"]!=v: raise ValueError("Decision ID already belongs to a different council record")
        db.execute("INSERT OR IGNORE INTO council_records VALUES (?,?)",(d["key"],v))
        return d["value"]
    if op=="council_get":
        row=db.execute("SELECT value FROM council_records WHERE key=?",(d["key"],)).fetchone()
        return json.loads(row["value"]) if row else None
    raise ValueError("Unknown queue operation")

try:
    req=json.load(sys.stdin)
    db.execute("BEGIN IMMEDIATE")
    result=operation(req["op"],req["data"])
    db.commit()
    print(encode(result))
except (ValueError,KeyError,TypeError,OverflowError,sqlite3.Error) as err:
    db.rollback()
    sys.exit(str(err))
finally:
    db.close()
