// Deterministic fake embedding provider for the embed tests — NO network, NO model.
// Speaks the FORGE_EMBED cmd protocol: {"texts":[..]} on stdin → {"vectors":[[..]]}
// on stdout. Failure modes for the graceful-degradation tests (argv):
//   --crash    exit 1 before answering
//   --garbage  print non-JSON
//   --sleep N  stall N ms before answering (drives the timeout path)
// Side effect: appends one line per invocation to $FAKE_EMBED_LOG so tests can count
// spawns and prove the disk cache avoids re-paying the provider.
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_EMBED_LOG) appendFileSync(process.env.FAKE_EMBED_LOG, "spawn\n");
if (args.includes("--crash")) process.exit(1);

// Designated "close" concept groups: any text containing one of a group's phrases
// embeds near that group's base direction (cosine ≈ 0.99 within the group). Everything
// else gets a hash-seeded pseudo-random 32-dim direction — expected |cosine| between
// unrelated texts ≈ 1/√32 ≈ 0.18, far below the 0.7 adapt bar.
const GROUPS = [
  ["delete a user account", "remove a user account"],
  ["parse a csv file", "read a csv file"],
];

const fnv1a = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
};

const DIM = 32;
const vecFromSeed = (seed) => {
  let x = seed >>> 0 || 1;
  const v = [];
  for (let i = 0; i < DIM; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    v.push((x / 0xffffffff) * 2 - 1);
  }
  return v;
};

const embedOne = (text) => {
  const t = String(text).toLowerCase();
  const g = GROUPS.findIndex((phrases) => phrases.some((p) => t.includes(p)));
  if (g < 0) return vecFromSeed(fnv1a(t));
  const base = vecFromSeed(1000 + g);
  const jitter = vecFromSeed(fnv1a(t));
  return base.map((x, i) => x + 0.05 * jitter[i]);
};

let raw = "";
process.stdin.on("data", (d) => {
  raw += d;
});
process.stdin.on("end", () => {
  if (args.includes("--garbage")) {
    process.stdout.write("this is not json {{{");
    return;
  }
  const { texts } = JSON.parse(raw);
  const reply = () => process.stdout.write(JSON.stringify({ vectors: texts.map(embedOne) }));
  const i = args.indexOf("--sleep");
  if (i >= 0) setTimeout(reply, Number(args[i + 1]) || 1000);
  else reply();
});
