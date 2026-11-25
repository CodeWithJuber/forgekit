// Run the public ForgeKit CLI against anonymous synthetic inputs, entirely offline.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = fileURLToPath(new URL("../../src/cli.js", import.meta.url));
const area = mkdtempSync(join(tmpdir(), "forge-workshop-"));
const root = join(area, "workspace"),
  home = join(area, "home"),
  inputs = join(root, "inputs");
mkdirSync(inputs, { recursive: true });
mkdirSync(home);
const env = {
  PATH: process.env.PATH,
  HOME: home,
  USERPROFILE: home,
  FORGE_HOME: join(area, "private-state"),
  FORGE_NO_HINT: "1",
  ...(process.platform === "win32"
    ? { SYSTEMROOT: process.env.SYSTEMROOT, TEMP: area, TMP: area }
    : {}),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: join(home, "unused-config"),
  GIT_TERMINAL_PROMPT: "0",
};
function run(bin, args) {
  return execFileSync(bin, args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20000,
  }).trim();
}
const forge = (...args) => JSON.parse(run(process.execPath, [cli, ...args]));
const git = (...args) => run("git", args);
try {
  for (const name of ["rsvps.csv", "rooms.csv"]) cpSync(join(here, name), join(inputs, name));
  cpSync(join(here, "streams.json"), join(root, "streams.json"));
  git("init", "-q");
  const question = "Choose a workshop slot that fits all interested participants";
  const planner = forge("agents", "run", "planner", "--task", question, "--json");
  assert.equal(planner.mode, "handoff");
  const team = forge(
    "team",
    question,
    "--brief",
    "streams.json",
    "--max-workers",
    "2",
    "--handoff",
    "generic",
    "--json",
  );
  assert.deepEqual(team.plan.lead.dependsOn, ["demand", "capacity"]);
  assert.match(team.briefs[0].brief, /inputs\/rsvps\.csv/);
  assert.doesNotMatch(team.briefs[0].brief, /inputs\/rooms\.csv/);

  const { configPath } = forge("sources", "init");
  writeFileSync(
    configPath,
    JSON.stringify({ sources: [{ id: "workshop", provider: "local", root: inputs }] }),
  );
  const aggregate = (file, column) =>
    forge(
      "sources",
      "aggregate",
      "workshop",
      file,
      "sum",
      "--column",
      column,
      "--group-by",
      "slot",
    );
  const rsvps = aggregate("rsvps.csv", "attendees"),
    rooms = aggregate("rooms.csv", "seats");
  const bySlot = (info) => Object.fromEntries(info.groups.map((g) => [g.group, Number(g.value)]));
  const demand = bySlot(rsvps),
    capacity = bySlot(rooms);
  // Independent acceptance values for these four RSVP rows and two capacity rows.
  assert.deepEqual(demand, { Morning: 12, Afternoon: 15 });
  assert.deepEqual(capacity, { Morning: 14, Afternoon: 14 });
  assert.equal(rsvps.rowsScanned, 4);
  assert.equal(rooms.rowsScanned, 2);
  const options = Object.keys(demand).map((slot) => ({
    slot,
    requested: demand[slot],
    seats: capacity[slot],
    spare: capacity[slot] - demand[slot],
  }));
  const accepted = options.filter((o) => o.spare >= 0);
  assert.deepEqual(accepted, [{ slot: "Morning", requested: 12, seats: 14, spare: 2 }]);
  const sourceHash = (name) =>
    createHash("sha256")
      .update(readFileSync(join(inputs, name)))
      .digest("hex");
  const sourceHashes = Object.fromEntries(
    ["rsvps.csv", "rooms.csv"].map((name) => [name, sourceHash(name)]),
  );
  const sourcesMatch = (record) =>
    Object.entries(record.sourceHashes).every(([name, hash]) => sourceHash(name) === hash);
  const receipt = {
    sourceHashes,
    dataset: "synthetic workshop",
    acceptance: "every RSVP fits",
    inputs: [rsvps, rooms],
    options,
    selected: accepted[0].slot,
  };
  writeFileSync(join(root, "checked-plan.json"), JSON.stringify(receipt, null, 2) + "\n");
  git("add", "inputs", "checked-plan.json", "streams.json");
  git(
    "-c",
    "user.name=Workshop fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "Record checked workshop plan and its source rows",
  );
  const revision = git("rev-parse", "HEAD"),
    spec = "Checked workshop seat plan for the frozen RSVP and capacity tables";
  const candidate = forge("reuse", "mint", spec, "--file", "checked-plan.json", "--json");
  assert.equal(candidate.serves, false);
  const acceptedArtifact = forge(
    "reuse",
    "mint",
    spec,
    "--file",
    "checked-plan.json",
    "--ref",
    `git:${revision}`,
    "--json",
  );
  assert.equal(acceptedArtifact.serves, true);
  const lookup = forge("reuse", "query", spec, "--json");
  assert.equal(lookup.artifact, acceptedArtifact.id);
  const blame = forge("ledger", "blame", acceptedArtifact.id, "--json");
  assert.ok(blame.evidence.some((e) => e.ref === `git:${revision}`));
  const saved = JSON.parse(readFileSync(join(root, "checked-plan.json"), "utf8"));
  assert.ok(sourcesMatch(saved));
  writeFileSync(
    join(inputs, "rsvps.csv"),
    readFileSync(join(inputs, "rsvps.csv"), "utf8") + "Morning,3\n",
  );
  assert.equal(sourcesMatch(saved), false);
  writeFileSync(join(root, "checked-plan.json"), "{}\n");
  const changed = forge("reuse", "query", spec, "--json");
  assert.equal(changed.tier, "miss");
  console.log(
    JSON.stringify(
      {
        dataset: receipt.dataset,
        workersStarted: 0,
        operator: team.plan.lead.owner,
        roles: team.plan.assignments.map((a) => a.role),
        options,
        chosen: receipt.selected,
        acceptance: receipt.acceptance,
        evidence: {
          revision,
          locators: ["inputs/rsvps.csv rows 2–5", "inputs/rooms.csv rows 2–3"],
        },
        reuse: {
          beforeProof: candidate.serves,
          afterProof: acceptedArtifact.serves,
          match: lookup.tier,
          changedSourceAction: sourcesMatch(saved) ? "reuse" : "recompute",
          afterReportChanged: changed.tier,
          claim: acceptedArtifact.id,
        },
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(area, { recursive: true, force: true });
}
