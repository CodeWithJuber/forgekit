// Local operator-owned, content-addressed receipts for a single reusable script.
// Capturing a candidate never executes it. All validation/expected-output comparison runs on the host.
import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { validateHarnessArgs } from "./harness_policy.js";
import { isolatedScript, readBounded, validateContainerVerifier } from "./harness_verify.js";
import { containsPath, outsideWorkspace } from "./private_paths.js";
import { hasSecret } from "./secrets.js";
import { privateWorkspaceFile } from "./workspace_preference.js";

const digest = (data) => createHash("sha256").update(data).digest("hex");
const sha = /^[a-f0-9]{64}$/;
const limit = 262144;
function requireValue(ok, why) {
  if (!ok) throw new Error(why);
}

function read(path) {
  return readBounded(path, limit).bytes.toString("utf8");
}
function folder(root) {
  const path = `${privateWorkspaceFile(root, "skill-scripts")}.d`;
  const dir = lstatSync(path, { throwIfNoEntry: false });
  requireValue(!dir || dir.isDirectory(), "Private script store must be a directory");
  return outsideWorkspace(root, path, "Keep private script storage outside the workspace");
}
function put(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), randomUUID());
  try {
    writeFileSync(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}
function recipeAt(root, id, hash) {
  requireValue(typeof hash === "string" && sha.test(hash), "Supply the reviewed --digest SHA-256");
  const text = read(join(folder(root), `${hash}.json`));
  requireValue(digest(text) === hash, "Script digest has changed");
  const recipe = JSON.parse(text);
  requireValue(recipe.id === id, "Script ID and digest disagree");
  return recipe;
}
function validateData(schema, data) {
  validateHarnessArgs(schema, data);
  requireValue(
    Buffer.byteLength(JSON.stringify(data)) <= 65536 &&
      !hasSecret(JSON.stringify(data), { entropy: false }),
    "Script data exceeds 64 KiB or contains a recognized credential",
  );
}
function capture(root, id, spec) {
  requireValue(
    typeof spec?.path === "string" && !isAbsolute(spec.path),
    "Supply a project-relative script path",
  );
  requireValue(
    Object.keys(spec).every((k) =>
      ["path", "runtime", "image", "inputSchema", "outputSchema", "fixtures"].includes(k),
    ),
    "Unknown script specification field",
  );
  const path = resolve(realpathSync.native(root), spec.path);
  requireValue(
    containsPath(realpathSync.native(root), path) && realpathSync.native(path) === path,
    "Script must be an unlinked workspace file",
  );
  const extension = extname(path);
  requireValue(
    [".mjs", ".cjs", ".py"].includes(extension),
    "Choose a standalone .mjs, .cjs or .py script",
  );
  validateContainerVerifier({ runtime: spec.runtime, image: spec.image, command: ["script"] });
  requireValue(
    Array.isArray(spec.fixtures) && spec.fixtures.length >= 1 && spec.fixtures.length <= 32,
    "Supply one to 32 fixtures with object input and expected output",
  );
  for (const fixture of spec.fixtures) {
    requireValue(
      fixture && Object.keys(fixture).every((k) => ["input", "expected"].includes(k)),
      "Expected fixture input and expected only",
    );
    validateData(spec.inputSchema, fixture.input);
    validateData(spec.outputSchema, fixture.expected);
  }
  const recipe = {
    id,
    version: 1,
    extension,
    runtime: spec.runtime,
    image: spec.image,
    inputSchema: spec.inputSchema,
    outputSchema: spec.outputSchema,
    fixtures: spec.fixtures,
    source: read(path),
  };
  const text = JSON.stringify(recipe);
  requireValue(
    Buffer.byteLength(text) <= limit && !hasSecret(text, { entropy: false }),
    "Script bundle exceeds the limit or contains a recognized credential",
  );
  const hash = digest(text);
  put(join(folder(root), `${hash}.json`), recipe);
  return {
    id,
    digest: hash,
    status: "candidate",
    fixtureCount: recipe.fixtures.length,
    runtime: recipe.runtime,
    image: recipe.image,
  };
}
export async function scriptCommand(op, root, id, { hash, input }, execute = isolatedScript) {
  requireValue(typeof id === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(id), "Invalid script ID");
  if (op === "capture-script") return capture(root, id, input);
  const dir = folder(root);
  const active = join(dir, `${id}.pin`);
  if (op === "replay-script") {
    requireValue(
      lstatSync(active, { throwIfNoEntry: false })?.isFile(),
      "Pin a verified script before replay",
    );
    hash = JSON.parse(read(active)).digest;
  }
  const recipe = recipeAt(root, id, hash);
  const evidence = join(dir, `${hash}.verification`);
  if (op === "verify-script") {
    let passed = 0;
    try {
      for (const fixture of recipe.fixtures) {
        const output = await execute(root, recipe, fixture.input);
        validateData(recipe.outputSchema, output);
        if (!isDeepStrictEqual(output, fixture.expected))
          throw new Error("Typed output differs from fixture");
        passed++;
      }
    } catch (err) {
      const receipt = {
        id,
        digest: hash,
        ok: false,
        status: "unverified",
        passed,
        total: recipe.fixtures.length,
        reason: err.message,
      };
      put(evidence, receipt);
      return receipt;
    }
    const receipt = {
      id,
      digest: hash,
      ok: true,
      status: "verified",
      passed,
      total: passed,
      image: recipe.image,
    };
    put(evidence, receipt);
    return receipt;
  }
  requireValue(
    lstatSync(evidence, { throwIfNoEntry: false })?.isFile(),
    "Verify the exact script digest before use",
  );
  const verified = JSON.parse(read(evidence));
  requireValue(verified.ok && verified.digest === hash, "Latest fixture verification must pass");
  if (op === "pin-script") {
    put(active, { digest: hash });
    return { id, digest: hash, status: "pinned" };
  }
  if (op !== "replay-script") throw new Error("Unknown script operation");
  validateData(recipe.inputSchema, input);
  const output = await execute(root, recipe, input);
  validateData(recipe.outputSchema, output);
  return { id, digest: hash, status: "executed", output };
}

export function listScripts(root) {
  const dir = folder(root);
  if (!lstatSync(dir, { throwIfNoEntry: false })) return [];
  return readdirSync(dir)
    .filter((f) => sha.test(basename(f, ".json")) && f.endsWith(".json"))
    .sort()
    .map((f) => {
      const hash = basename(f, ".json");
      const text = read(join(dir, f));
      requireValue(digest(text) === hash, "Script digest has changed");
      const { id, image, runtime, fixtures } = JSON.parse(text);
      requireValue(
        typeof id === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(id),
        "Invalid stored script ID",
      );
      const verified = join(dir, `${hash}.verification`),
        pin = join(dir, `${id}.pin`);
      return {
        id,
        digest: hash,
        image,
        runtime,
        fixtureCount: fixtures.length,
        verified:
          (lstatSync(verified, { throwIfNoEntry: false })?.isFile() &&
            JSON.parse(read(verified)).ok) ||
          false,
        pinned:
          (lstatSync(pin, { throwIfNoEntry: false })?.isFile() &&
            JSON.parse(read(pin)).digest === hash) ||
          false,
      };
    });
}
