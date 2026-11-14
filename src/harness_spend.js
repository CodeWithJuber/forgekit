// Daily ceiling spans this operator's projects. A project ceiling is shared by its Git
// worktrees. SQLite serialises reservation/settlement even across separate CLI processes.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  harnessChildPath,
  installedHarnessProgram,
  installedHarnessPython,
} from "./harness_python.js";
import { outsideWorkspace } from "./private_paths.js";
import { contentHash, userStateDir } from "./util.js";

const script = fileURLToPath(new URL("./harness_spend.py", import.meta.url));
function privateLedger(root) {
  if (!root) throw new Error("Paid model dispatch needs a workspace and configured spend ceilings");
  const work = realpathSync.native(root);
  const git = installedHarnessProgram(work, "git");
  const gitState = spawnSync(
    git,
    ["-c", "core.fsmonitor=false", "rev-parse", "--path-format=absolute", "--git-common-dir"],
    {
      cwd: work,
      env: { ...process.env, PATH: harnessChildPath(work), LC_ALL: "C" },
      encoding: "utf8",
      timeout: 4000,
      windowsHide: true,
    },
  );
  if (
    gitState.status !== 0 &&
    !(gitState.status === 128 && gitState.stderr?.includes("not a git repository"))
  )
    throw new Error("Cannot determine project identity for spend limits");
  const common = gitState.status === 0 ? gitState.stdout.trim() : "";
  const project = contentHash(common ? realpathSync.native(common) : work);
  const physical = outsideWorkspace(
    work,
    userStateDir(),
    "Keep harness spend state outside the workspace",
  );
  const dir = join(physical, "harness-spend");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (realpathSync.native(dir) !== dir) throw new Error("Unsafe spend store directory");
  const file = join(dir, "spend.sqlite");
  for (const name of [file, `${file}-journal`, `${file}-wal`, `${file}-shm`]) {
    const st = lstatSync(name, { throwIfNoEntry: false });
    if (st && (!st.isFile() || st.nlink !== 1)) throw new Error("Unsafe spend store file");
  }
  return { file, project, python: installedHarnessPython(work) };
}

function op(store, operation) {
  const result = spawnSync(store.python, ["-I", "-B", script], {
    cwd: dirname(script),
    input: JSON.stringify({ ...store, ...operation }),
    encoding: "utf8",
    timeout: 8000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    throw new Error("Spend ledger unavailable; check Python 3, SQLite and file permissions");
  return JSON.parse(result.stdout);
}

function units(value, rounding) {
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(rounding(value * 1e9)))
    throw new Error("Invalid spend ceiling or amount");
  return rounding(value * 1e9);
}

export function reserveHarnessSpend(root, ceilings, expectedUsd) {
  const store = privateLedger(root);
  const id = randomUUID();
  const reserved = op(store, {
    op: "reserve",
    id,
    amount: units(expectedUsd, Math.ceil),
    dailyLimit: units(ceilings?.dailyUsd ?? 0, Math.floor),
    projectLimit: units(ceilings?.projectUsd ?? 0, Math.floor),
  });
  if (!reserved.reserved) return { reason: reserved.reason };
  return {
    settle: (actualUsd, estimated) =>
      op(store, {
        op: "settle",
        id,
        amount: units(actualUsd, Math.ceil),
        status: estimated ? "estimated" : "reported",
      }),
  };
}

export function harnessSpend(root) {
  return op(privateLedger(root), { op: "summary" });
}
