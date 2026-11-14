"""Private SQLite memory, accessed only by the trusted harness. One transaction per request."""
import datetime
import hashlib
import json
import os
import re
import sqlite3
import struct
import sys
import time
import unicodedata
import uuid


SCHEMA = """
CREATE TABLE IF NOT EXISTS observations(
  id TEXT PRIMARY KEY, repo TEXT NOT NULL, run TEXT NOT NULL, command TEXT NOT NULL,
  at REAL NOT NULL, digest TEXT NOT NULL, kind TEXT NOT NULL, success INTEGER NOT NULL,
  usable INTEGER NOT NULL, output TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS items(
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, layer TEXT NOT NULL, text TEXT NOT NULL,
  level TEXT NOT NULL, evidence TEXT, run TEXT NOT NULL, created REAL NOT NULL,
  verified REAL, supersedes TEXT, active INTEGER NOT NULL, review INTEGER NOT NULL,
  support INTEGER NOT NULL, against INTEGER NOT NULL, weight REAL NOT NULL, used REAL NOT NULL,
  signature BLOB NOT NULL);
CREATE INDEX IF NOT EXISTS scope_active ON items(scope,active,layer);
CREATE VIRTUAL TABLE IF NOT EXISTS lookup USING fts5(id UNINDEXED,scope UNINDEXED,text);
CREATE TABLE IF NOT EXISTS ledger(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, id TEXT, at REAL NOT NULL,
  run TEXT NOT NULL, event TEXT NOT NULL, details TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS item_history ON ledger(scope,id,seq);
CREATE TRIGGER IF NOT EXISTS ledger_immutable_update BEFORE UPDATE ON ledger
  BEGIN SELECT RAISE(ABORT,'ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_immutable_delete BEFORE DELETE ON ledger
  BEGIN SELECT RAISE(ABORT,'ledger is append-only'); END;
CREATE TABLE IF NOT EXISTS edges(
  scope TEXT NOT NULL, src TEXT NOT NULL, relation TEXT NOT NULL,dst TEXT NOT NULL,
  PRIMARY KEY(scope,src,relation,dst));
CREATE INDEX IF NOT EXISTS edge_destination ON edges(scope,dst);
CREATE INDEX IF NOT EXISTS command_lookup ON observations(repo,command);
CREATE TABLE IF NOT EXISTS finished(repo TEXT NOT NULL,run TEXT NOT NULL,reply TEXT NOT NULL,
  PRIMARY KEY(repo,run));
CREATE TABLE IF NOT EXISTS sources(
  repo TEXT NOT NULL, source TEXT NOT NULL, revision INTEGER NOT NULL, observed REAL NOT NULL,
  initialized REAL NOT NULL, changes INTEGER NOT NULL, PRIMARY KEY(repo,source));
CREATE TABLE IF NOT EXISTS leaves(
  repo TEXT NOT NULL,source TEXT NOT NULL,bucket TEXT NOT NULL,key TEXT NOT NULL,val TEXT NOT NULL,
  PRIMARY KEY(repo,source,bucket,key));
CREATE TABLE IF NOT EXISTS nodes(
  repo TEXT NOT NULL, source TEXT NOT NULL,parent TEXT NOT NULL, path TEXT NOT NULL,val TEXT NOT NULL,
  PRIMARY KEY(repo,source,parent,path));
"""
HALF_LIFE = {"semantic": 180, "procedural": 365, "episodic": 30}
WEIGHT = {"L1": 0.4, "L2": 0.75, "L3": 1}
PRIOR = {"L1": (1, 3), "L2": (3, 2), "L3": (8, 1)}


def uid():
    return uuid.uuid4().hex


def timestamp(ts):
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).isoformat()


def signature(text):
    tokens = re.findall(r"\w+", unicodedata.normalize("NFKC", text).casefold())
    grams = {" ".join(tokens[i:i+5]) for i in range(max(1, len(tokens)-4))}
    hashes = [int.from_bytes(hashlib.blake2s(g.encode(), digest_size=4).digest(), "big") for g in grams]
    vals = [min((v * ((i * 0x9e3779b1) | 1) + i * 0x85ebca6b) & 0xffffffff for v in hashes)
            for i in range(1, 129)]
    return struct.pack(">128I", *vals)


def query_fts(query):
    words = list(dict.fromkeys(re.findall(r"\w+", query.casefold())))[:20]
    return " OR ".join('"' + w[:100] + '"' for w in words)


class Memory:
    def __init__(self, db, args):
        self.db = db
        self.scopes = args["scopes"]
        self.repo = self.scopes["repo"]
        self.now = time.time()

    def log(self, scope, item, run, event, details):
        self.db.execute("INSERT INTO ledger(scope,id,at,run,event,details) VALUES(?,?,?,?,?,?)",
                        (scope, item, self.now, run, event, json.dumps(details)))

    def edge(self, scope, src, rel, dst):
        if dst:
            self.db.execute("INSERT OR IGNORE INTO edges VALUES(?,?,?,?)", (scope, src, rel, dst))

    def observation(self, run, eid):
        if not isinstance(eid, str):
            return None
        return self.db.execute("SELECT * FROM observations WHERE id=? AND repo=? AND run=?",
                               (eid, self.repo, run)).fetchone()

    def observe(self, p):
        key = hashlib.sha256(json.dumps([self.repo, p["runId"], p["kind"], p["command"],
                                         p["digest"], p["success"], p["usable"]]).encode()).hexdigest()
        # An incomplete trailing line cannot attest to a complete claim.
        output = p["output"].rsplit("\n", 1)[0] if p["truncated"] and "\n" in p["output"] else (
            "" if p["truncated"] else p["output"])
        self.db.execute("INSERT OR IGNORE INTO observations VALUES(?,?,?,?,?,?,?,?,?,?)",
                        (key, self.repo, p["runId"], p["command"], self.now, p["digest"],
                         p["kind"], p["success"], p["usable"], output))
        obs = self.observation(p["runId"], key)
        if obs["kind"] == "check" and not obs["success"] and obs["usable"]:
            # This command's procedure just failed. A semantic assertion that
            # happens to cite this command could still be true; a reviewer checks it.
            rows = self.db.execute("""SELECT id FROM items WHERE scope=? AND layer='procedural'
                                   AND text=? AND level='L3' AND active=1""",
                                   (self.repo, obs["command"])).fetchall()
            for row in rows:
                self.contradict({"id": row["id"], "runId": p["runId"], "evidenceId": key})
        return {"id": key, "runId": obs["run"], "command": obs["command"], "at": timestamp(obs["at"]),
                "digest": obs["digest"], "kind": obs["kind"], "success": bool(obs["success"])}

    def refuse(self, p, reason):
        self.log(self.repo, None, p["runId"], "refused", {"reason": reason})
        return {"stored": False, "reason": reason}

    def matches(self, scope, query, limit=64):
        q = query_fts(query)
        if not q:
            return []
        return self.db.execute("""SELECT i.* FROM lookup JOIN items i ON i.id=lookup.id
          WHERE lookup MATCH ? AND i.scope=? AND i.active=1 ORDER BY bm25(lookup),i.id LIMIT ?""",
                               (q, scope, limit)).fetchall()

    def store(self, scope, text, level, layer, run, evidence, source=None):
        sig = signature(text)
        # Shortlist from FTS before comparing 128-lane, five-token MinHash.
        old = next((r for r in self.matches(scope, text) if layer != "episodic" and r["layer"] == layer and
                    sum(a == b for a, b in zip(struct.iter_unpack(">I", r["signature"]),
                                                struct.iter_unpack(">I", sig))) > 128*0.8), None)
        if old and old["text"] == text and old["evidence"] == evidence and old["level"] == level:
            return {"stored": True, "id": old["id"], "level": level, "deduplicated": True}
        if old and self.human_confirmed(old) and source != "operator":
            return self.refuse({"runId": run}, "a maintainer must revise human-confirmed memory")
        if old and WEIGHT[level] < WEIGHT[old["level"]]:
            return self.refuse({"runId": run}, "weaker evidence cannot replace a stronger item")
        iid = uid()
        if old:
            # A changed verified statement can invalidate explicitly shared
            # snapshots. Keep their old evidence and mark them for local review.
            if (scope == self.repo and old["level"] == "L3" and old["text"] != text
                    and old["evidence"] != evidence and self.observation(run, evidence)):
                self.contradict({"id":old["id"],"runId":run,"evidenceId":evidence})
            self.db.execute("UPDATE items SET active=0 WHERE id=?", (old["id"],))
            self.db.execute("DELETE FROM lookup WHERE id=?", (old["id"],))
            self.log(scope, old["id"], run, "superseded", {"newId": iid})
            self.edge(scope, iid, "supersedes", old["id"])
        self.db.execute("INSERT INTO items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (iid, scope, layer, text, level, evidence, run, self.now,
                         self.now if level == "L3" else None, old["id"] if old else None,
                         1, 0, *PRIOR[level], 0.5, self.now, sig))
        self.db.execute("INSERT INTO lookup VALUES(?,?,?)", (iid, scope, text))
        self.log(scope, iid, run, "stored", {"level": level, "layer": layer, "evidence": evidence,
                                            "supersedes": old["id"] if old else None, "source": source})
        self.edge(scope, iid, "observed-in", run)
        self.edge(scope, iid, "evidenced-by", evidence)
        return {"stored": True, "id": iid, "level": level}

    def propose(self, p):
        if "refusal" in p:
            return self.refuse(p, p["refusal"])
        level, layer, run = p.get("level"), p.get("layer"), p["runId"]
        if layer not in ("semantic", "procedural") or level not in ("L2", "L3"):
            return self.refuse(p, "semantic memory requires an observation, procedures require a passed check")
        obs = self.observation(run, p.get("evidenceId"))
        if not obs or not obs["usable"]:
            return self.refuse(p, "missing usable observation in this run")
        if (level == "L3" or layer == "procedural") and not (obs["kind"] == "check" and obs["success"]):
            return self.refuse(p, "a successful executable check is required")
        if layer == "procedural" and (level != "L3" or p["text"] != obs["command"]):
            return self.refuse(p, "procedure must match the executed, verified command")
        if layer == "semantic" and p["text"] not in [s.strip() for s in obs["output"].splitlines()]:
            return self.refuse(p, "claim must match a complete observed output line")
        scope = self.scopes.get(p.get("scope"))
        if not scope:
            return self.refuse(p, "scope unavailable")
        result = self.store(scope, p["text"], level, layer, run, obs["id"])
        if result["stored"]:
            self.edge(scope, obs["id"], "checked-by", obs["command"])
        return result

    def share(self, p):
        target = self.scopes.get(p.get("target"))
        if not target or target == self.repo:
            raise ValueError("Enable the target scope explicitly")
        row = self.db.execute("SELECT * FROM items WHERE id=? AND scope=? AND active=1 AND review=0",
                              (p.get("id"), self.repo)).fetchone()
        if not row or row["level"] != "L3":
            raise ValueError("Only verified repo items may be shared")
        result = self.store(target, row["text"], row["level"], row["layer"], row["run"],
                            row["evidence"], source=row["id"])
        if result["stored"]:
            self.edge(target, result["id"], "shared-from", row["id"])
        return result

    def contradict(self, p):
        row = self.db.execute("SELECT * FROM items WHERE scope=? AND id=? AND active=1",
                              (self.repo, p.get("id"))).fetchone()
        obs = self.observation(p["runId"], p.get("evidenceId"))
        if not row or not obs or not obs["usable"] or row["evidence"] == obs["id"]:
            raise ValueError("Contradiction requires the current item and independent observed evidence")
        shared = self.db.execute("""SELECT i.* FROM items i JOIN edges e ON e.src=i.id AND e.scope=i.scope
                                   WHERE e.relation='shared-from' AND e.dst=? AND i.active=1""",
                                 (row["id"],)).fetchall()
        for r in [row, *shared]:
            if r["review"]:
                continue
            self.db.execute("UPDATE items SET level='L1',review=1,against=against+2 WHERE id=?", (r["id"],))
            self.log(r["scope"], r["id"], p["runId"], "contradicted",
                     {"previous": r["level"], "level": "L1", "evidence": obs["id"]})
        return {"id": row["id"], "level": "L1", "review": True}

    def correct(self, p):
        # Caller is a local human operator. Keep the original verifiable receipt
        # and record a human attestation separately from executable verification.
        old = self.db.execute("SELECT * FROM items WHERE scope=? AND id=? AND active=1",
                              (self.repo,p["id"])).fetchone()
        if not old:
            raise ValueError("Correction requires an existing active repo item")
        receipt = self.observe({"runId":p["runId"], "kind":"human", "command":p["actor"],
                                "digest":hashlib.sha256(p["reason"].encode()).hexdigest(), "success":True,
                                "usable":True,"output":p["reason"], "truncated":False})
        self.contradict({"id":p["id"],"runId":p["runId"],"evidenceId":receipt["id"]})
        self.db.execute("UPDATE items SET active=0 WHERE id=?", (old["id"],))
        self.db.execute("DELETE FROM lookup WHERE id=?", (old["id"],))
        new = self.store(self.repo,p["text"],"L3","semantic",p["runId"],receipt["id"],source="operator")
        if not new["stored"]:
            raise ValueError("Human correction conflicted with an existing memory item")
        self.db.execute("UPDATE items SET supersedes=? WHERE id=?", (old["id"], new["id"]))
        self.edge(self.repo,new["id"],"supersedes",old["id"])
        self.log(self.repo,old["id"],p["runId"],"superseded",{"newId":new["id"]})
        self.log(self.repo,new["id"],p["runId"],"human-confirmed",{"actor":p["actor"],"reason":p["reason"],"evidence":receipt["id"]})
        return new

    def weight(self, r):
        days = max(0, (self.now-r["used"])/86400)
        return max(0.05, r["weight"] * 0.999**days)

    def finish(self, p):
        run = p["runId"]
        prior = self.db.execute("SELECT reply FROM finished WHERE repo=? AND run=?", (self.repo, run)).fetchone()
        if prior:
            return json.loads(prior[0])
        obs = self.observation(run, p.get("evidenceId"))
        proven = bool(obs and obs["kind"] == "check" and obs["success"] and p["status"] == "done")
        episode = self.store(self.repo, f"Run {run} ended with status {p['status']}", "L2", "episodic",
                             run, obs["id"] if obs else None)
        # A passing project suite authenticates its own result, not any model-authored assertion.
        writes = [self.propose(q) if proven else self.refuse(q, "run did not verify") for q in p["proposals"]]
        if obs and obs["kind"] == "check":
            for iid in set(i for i in p["recallIds"] if isinstance(i, str)):
                r = self.db.execute("SELECT * FROM items WHERE scope=? AND id=? AND active=1",
                                    (self.repo,iid)).fetchone()
                if not r:
                    continue
                w = self.weight(r)
                if proven:
                    w += 0.1 * (1-w)
                elif not obs["success"]:
                    w *= 0.8
                else:
                    continue
                self.db.execute("UPDATE items SET weight=?,used=?,support=support+? WHERE id=?",
                                (max(0.05,w),self.now,int(proven),iid))
                self.edge(self.repo, episode["id"], "used", iid)
        result = {"episode": episode, "proposals": writes, "verified": proven}
        self.db.execute("INSERT INTO finished VALUES(?,?,?)", (self.repo, run, json.dumps(result)))
        return result

    def human_confirmed(self, r):
        return self.db.execute("SELECT 1 FROM observations WHERE id=? AND kind='human'", (r["evidence"],)).fetchone()

    def public(self, r):
        confirmed = self.human_confirmed(r)
        return {"id": r["id"], "text": r["text"], "scope": next((n for n,s in self.scopes.items() if s==r["scope"]), "shared"),
                "level": r["level"], "layer": r["layer"], "evidenceId": r["evidence"],
                "provenance":"human-confirmed" if confirmed else "harness",
                "sourceRun": r["run"], "createdAt":timestamp(r["created"]),
                "verifiedAt":timestamp(r["verified"]) if r["verified"] else None, "review": bool(r["review"]),
                "supersedes":r["supersedes"]}

    def recall(self, p):
        for name, scope in self.scopes.items():
            lex = self.matches(scope,p["query"],128)
            if not lex:
                continue
            rows = {r["id"]: r for r in lex}
            scores = {r["id"]:1/(61+i) for i,r in enumerate(lex)}
            # A shared receipt or run connects related successful observations.
            # Bound every branch before scoring so common commands cannot flood recall.
            graph_ids = []
            for r in lex[:12]:
                neighbors = self.db.execute("""SELECT DISTINCT i.* FROM edges a JOIN edges b ON b.dst=a.dst AND b.scope=a.scope
                  JOIN items i ON i.id=b.src WHERE a.scope=? AND a.src=? AND i.id!=a.src
                  AND a.relation IN ('evidenced-by','observed-in') AND a.relation=b.relation AND i.active=1
                  ORDER BY i.created DESC,i.id LIMIT 8""", (scope,r["id"])).fetchall()
                for n in neighbors:
                    rows[n["id"]] = n
                    if n["id"] not in graph_ids:
                        graph_ids.append(n["id"])
            for i,iid in enumerate(graph_ids):
                scores[iid] = scores.get(iid, 0) + 1/(61+i)
            recent = sorted(rows.values(), key=lambda r:(-r["created"],r["id"]))
            for i,r in enumerate(recent):
                scores[r["id"]] += 1/(61+i)
            result = []
            for iid,r in rows.items():
                age = max(0,(self.now-(r["verified"] or r["created"]))/86400)
                score = (scores[iid] * WEIGHT[r["level"]] * (0.5**(age/HALF_LIFE[r["layer"]]))
                         * (1.25 if name=="repo" else 1 if name=="team" else .8)
                         * self.weight(r) * r["support"]/(r["support"]+r["against"]))
                result.append({**self.public(r), "score":score})
            return sorted(result,key=lambda r:(-r["score"],r["id"]))[:p["limit"]]
        return []

    def source(self, p):
        loc = (self.repo, p["source"])
        row = self.db.execute("SELECT * FROM sources WHERE repo=? AND source=?", loc).fetchone()
        root = self.db.execute("SELECT val FROM nodes WHERE repo=? AND source=? AND parent='@' AND path=''", loc).fetchone()
        if not row:
            return {"revision":0, "root":None, "refreshSeconds":900, "nextRefreshAt":None}
        elapsed = max(1,row["observed"]-row["initialized"])
        # Count change-bearing observations (events), not every changed file in a batch.
        # One observation cannot estimate a rate. Use a short initial sampling interval.
        interval = max(900,min(7*86400,elapsed/row["changes"])) if row["changes"] else max(900,min(7*86400,elapsed))
        return {"revision":row["revision"],"root":root[0] if root else None,
                "refreshSeconds":round(interval),"nextRefreshAt":timestamp(row["observed"]+interval)}

    def refresh(self, p):
        state = self.source(p)
        if state["revision"] != p["expectedRevision"]:
            raise ValueError("Source revision changed; read the current manifest before retrying")
        loc = (self.repo, p["source"])
        changed = set()
        count = 0
        for key, val in p["delta"]:
            bucket = key[:4]
            ident = (*loc, bucket, key)
            old = self.db.execute("SELECT val FROM leaves WHERE repo=? AND source=? AND bucket=? AND key=?", ident).fetchone()
            if (old[0] if old else None) == val:
                continue
            count += 1
            changed.add(bucket)
            if val is None:
                self.db.execute("DELETE FROM leaves WHERE repo=? AND source=? AND bucket=? AND key=?", ident)
            else:
                self.db.execute("INSERT OR REPLACE INTO leaves VALUES(?,?,?,?,?)", (*ident,val))
        # Rebuild only touched buckets and their ancestors in this 16-way prefix tree.
        # Hashing fixed-size hex key/digest pairs makes child boundaries unambiguous.
        rebuilt = 0
        for level in range(4,-1,-1):
            for path in changed:
                if level==4:
                    children = self.db.execute("SELECT key,val FROM leaves WHERE repo=? AND source=? AND bucket=? ORDER BY key",(*loc,path))
                else:
                    children = self.db.execute("SELECT path,val FROM nodes WHERE repo=? AND source=? AND parent=? ORDER BY path",(*loc,path))
                pairs = "".join(k+v for k,v in children)
                pointer = (*loc,path[:-1] if path else "@",path)
                if pairs:
                    h = hashlib.sha256(pairs.encode("ascii")).hexdigest()
                    self.db.execute("INSERT OR REPLACE INTO nodes VALUES(?,?,?,?,?)", (*pointer,h))
                else:
                    self.db.execute("DELETE FROM nodes WHERE repo=? AND source=? AND parent=? AND path=?",pointer)
                rebuilt += 1
            changed = {k[:-1] for k in changed}
        # Revision advances on each successful compare-and-swap including unchanged
        # observations. A stale uploader must never overwrite newer indexed content.
        self.db.execute("""INSERT INTO sources VALUES(?,?,1,?,?,0) ON CONFLICT(repo,source)
                        DO UPDATE SET revision=revision+1,observed=excluded.observed,changes=changes+?""",
                        (*loc,self.now,self.now,int(count>0)))
        return {**self.source(p),"changedChunks":count,"rehashedNodes":rebuilt}

    def history(self, p):
        for scope in self.scopes.values():
            log = self.db.execute("SELECT * FROM ledger WHERE scope=? AND id=? ORDER BY seq", (scope,p.get("id"))).fetchall()
            if log:
                return [{"seq":r["seq"], "event":r["event"], "at":timestamp(r["at"]),
                         "runId":r["run"], "details":json.loads(r["details"])} for r in log]
        return []

    def graph(self, p):
        seen = {p["query"]}
        frontier = set(seen)
        edges = set()
        for _ in range(p["depth"]):
            nxt = set()
            for node in sorted(frontier)[:64]:
                for r in self.db.execute("SELECT src,relation,dst FROM edges WHERE scope=? AND (src=? OR dst=?) LIMIT 32",
                                         (self.repo,node,node)):
                    edges.add(tuple(r))
                    nxt.update((r[0],r[2]))
            frontier = nxt-seen
            seen |= nxt
        return [{"from":a,"relation":b,"to":c} for a,b,c in sorted(edges)[:256]]

    def candidates(self):
        return [self.public(r) for r in self.db.execute(
            "SELECT * FROM items WHERE scope=? AND active=1 AND review=1 ORDER BY created DESC LIMIT 100", (self.repo,))]

    def receipt(self, p):
        # A repository grant for one shared claim doesn't grant access to the
        # rest of the originating command's output. Return only local receipts.
        row = self.db.execute("SELECT * FROM observations WHERE id=? AND repo=?",
                              (p.get("id"), self.repo)).fetchone()
        if not row:
            raise ValueError("Evidence unavailable in this workspace")
        return {"id":row["id"],"runId":row["run"],"at":timestamp(row["at"]),"command":row["command"],
                "kind":row["kind"],"success":bool(row["success"]), "digest":row["digest"],
                "usable":bool(row["usable"]), "output":row["output"]}

    def review(self, p):
        limit = p["limit"]
        due = self.db.execute("""SELECT * FROM items WHERE scope=? AND level='L3' AND active=1 AND verified<?
                              ORDER BY verified,id LIMIT ?""",(self.repo,self.now-30*86400,limit)).fetchall()
        episodes = self.db.execute("""SELECT * FROM items WHERE scope=? AND active=1 AND layer='episodic' AND created>=?
                                   ORDER BY created DESC LIMIT ?""",(self.repo,self.now-86400,limit)).fetchall()
        refusals = self.db.execute("""SELECT details,count(*) FROM ledger WHERE scope=? AND event='refused' AND at>=?
                                   GROUP BY details ORDER BY count(*) DESC LIMIT ?""",(self.repo,self.now-7*86400,limit)).fetchall()
        return {"contradictions":self.candidates()[:limit], "reverifyDue":[self.public(r) for r in due],
                "recentEpisodes":[self.public(r) for r in episodes],
                "rejectedThisWeek":[{"reason":json.loads(details)["reason"], "count":count} for details,count in refusals]}

    def stats(self):
        return {"scope":"repo","layers":{r[0]:r[1] for r in self.db.execute(
            "SELECT layer,count(*) FROM items WHERE scope=? AND active=1 GROUP BY layer",(self.repo,))},
                "ledgerEntries":self.db.execute("SELECT count(*) FROM ledger WHERE scope=?",(self.repo,)).fetchone()[0],
                "refused":self.db.execute("SELECT count(*) FROM ledger WHERE scope=? AND event='refused'",(self.repo,)).fetchone()[0]}


def main():
    os.umask(0o077)
    payload = json.load(sys.stdin)
    db = sqlite3.connect(sys.argv[1], timeout=5)
    db.row_factory = sqlite3.Row
    try:
        db.executescript(SCHEMA)
        with db:
            db.execute("BEGIN IMMEDIATE")
            mem = Memory(db,payload)
            op = payload["op"]
            if op == "stats":
                result = mem.stats()
            elif op == "candidates":
                result = mem.candidates()
            elif op == "propose":
                result = mem.propose(payload["proposal"])
            elif op in {"observe","finish","history","graph","contradict","share","recall","source","refresh","correct","review","receipt"}:
                result = getattr(mem,op)(payload)
            else:
                raise ValueError("Unknown memory operation")
        print(json.dumps({"value":result}))
    except ValueError as exc:
        print(json.dumps({"error":str(exc)}))
    finally:
        db.close()


if __name__ == "__main__":
    main()
