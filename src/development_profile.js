// Personal selection of shipped prompts. The repository and retrieved sources cannot add
// instructions here. Rendering looks up a built-in ID and never sends the preference upstream.
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { masterPrompt, painPrompts, rolePrompts } from "./development_prompt_library.js";
import { privateWorkspaceFile } from "./workspace_preference.js";

const profiles = ["engineering", "quran"];
const principles = [
  {
    concept: "La taqfu",
    reference: "17:36",
    application: "Identify the file, command or source behind a factual claim.",
  },
  {
    concept: "Tabayyun",
    reference: "49:6",
    application: "Check a report against current observations before acting.",
  },
  {
    concept: "Ta'lim al-asma",
    reference: "2:31–32",
    application: "Resolve names, contracts and callers in the current codebase.",
  },
  {
    concept: "Rabbi zidni ilma",
    reference: "20:114",
    application: "Update knowledge when an observed result changes it.",
  },
  {
    concept: "Iqra and al-qalam",
    reference: "96:1–5",
    application: "Preserve decisions, rejections and their evidence for the next session.",
  },
  {
    concept: "Hal yastawi",
    reference: "39:9",
    application: "Distinguish checked evidence, inferences and unknowns.",
  },
  {
    concept: "Tadabbur and consistency",
    reference: "4:82",
    application: "Check the final diff against the plan and investigate contradictions.",
  },
  {
    concept: "Tadabbur and reflection",
    reference: "47:24",
    application: "After repeat failures, reopen the assumption and try a different explanation.",
  },
  {
    concept: "Amana",
    reference: "33:72",
    application: "Limit access and edits to the authorized task and preserve an undo path.",
  },
  {
    concept: "Ilm, fahm and hikma",
    reference: null,
    application: "Separate observations, repeated patterns and proposed guidance.",
  },
  {
    concept: "Hifz and murajaa",
    reference: null,
    application: "Review stored guidance and downgrade it when evidence changes.",
  },
  {
    concept: "Tadabbur and consequences",
    reference: null,
    application: "Trace downstream effects, compatibility and cost before choosing.",
  },
  {
    concept: "Tabayyun at the decision point",
    reference: null,
    application: "Re-read the relevant state when an earlier result is stale.",
  },
  {
    concept: "Amana and accountability",
    reference: null,
    application: "Give each consequential action an owner and a verifiable outcome.",
  },
];

const ethics =
  "Quran-framed practice: verify reports (49:6), ground claims in knowledge (17:36), respect entrusted access (33:72) and consult on consequential choices (42:38). Technical conclusions require project evidence.";
const operatingRule =
  "State the outcome and its acceptance check. Read the current callers and tests, compare reusable options, then make a reversible change. Record actual commands, results, skipped checks and residual risks.";
const receipt =
  "Outcome, commands and observed results, changed paths, unchecked behavior and residual risks.";

const fileFor = (root) => privateWorkspaceFile(root, "prompt-profiles");

/** Reading the default never creates any files. */
export function promptStatus(root = process.cwd()) {
  const file = fileFor(root);
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 128)
      throw new Error("Invalid personal prompt profile record");
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (!profiles.includes(value?.profile)) throw new Error("Unknown saved prompt profile");
    return { profile: value.profile, scope: "user-worktree" };
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    return { profile: "off", scope: "user-worktree" };
  }
}

export function selectPromptProfile(root, profile) {
  if (!profiles.includes(profile) && profile !== "off")
    throw new Error("Choose engineering, quran or off");
  const file = fileFor(root);
  if (profile === "off") rmSync(file, { force: true });
  else {
    mkdirSync(dirname(file), { mode: 0o700, recursive: true });
    const temp = `${file}.${randomUUID()}`;
    try {
      writeFileSync(temp, JSON.stringify({ profile }), { mode: 0o600, flag: "wx" });
      renameSync(temp, file);
    } finally {
      rmSync(temp, { force: true });
    }
  }
  return { profile, scope: "user-worktree" };
}

const choice = ({ id, title }) => ({ id, title });
export function listDevelopmentPrompts() {
  return {
    profiles,
    master: "master",
    roles: rolePrompts.map(choice),
    pains: painPrompts.map(choice),
  };
}

/** @returns {{id:string,title:string,profile:string,prompt:string,proof:string,principles?:typeof principles}} */
export function showDevelopmentPrompt(id, profile = "engineering") {
  if (!profiles.includes(profile)) throw new Error("Choose engineering or quran");
  const card =
    id === "master"
      ? { id, title: "Development workflow", prompt: masterPrompt, proof: receipt }
      : [...rolePrompts, ...painPrompts].find((card) => card.id === id);
  if (!card) throw new Error("Unknown prompt ID. Use forge prompts list");
  const result = { ...choice(card), profile, prompt: card.prompt, proof: card.proof };
  if (profile === "quran")
    return {
      ...result,
      prompt: `${ethics}\n\n${card.prompt}`,
      ...(id === "master" ? { principles } : {}),
    };
  return result;
}

/** Only a valid, personally selected profile reaches model-facing context. Errors affect this
 * optional feature alone, so an unreadable preference cannot suppress the existing hook. */
export function activePromptProfile(root) {
  try {
    return promptStatus(root).profile;
  } catch {
    return "off";
  }
}

export function profileGuidance(profile, task, evidence) {
  if (!profiles.includes(profile)) return null;
  const pains = painPrompts.filter((card) => card.trigger.test(task.slice(0, 4000))).slice(0, 2);
  const basis =
    evidence.symbols?.length || evidence.hits?.length
      ? "Local candidates were retrieved. Read the cited locations before using them as proof."
      : "No supporting local match was retrieved. Verify assumptions against the current files.";
  return {
    profile,
    basis,
    pains: pains.map(choice),
    text: [
      profile === "quran" ? ethics : "Engineering evidence profile.",
      operatingRule,
      basis,
      ...pains.map((c) => `${c.title} — ${c.prompt} Expected evidence: ${c.proof}`),
    ].join("\n"),
  };
}

/** argv starts at 'prompts', like the other CLI handlers. show prints portable plain
 * text for copy/paste or redirection; all commands support machine-readable output. */
export function handleDevelopmentPrompts(argv) {
  const { positionals, values } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: { json: { type: "boolean" }, profile: { type: "string" } },
  });
  const [cmd = "list", arg] = positionals;
  if (values.profile !== undefined && cmd !== "show")
    throw new Error("--profile applies to prompts show");
  const root = process.cwd();
  let data, text;
  if (cmd === "list" && positionals.length <= 1) {
    data = listDevelopmentPrompts();
    text = [
      "Enable a personal profile here with forge prompts use engineering or forge prompts use quran.",
      "Use forge prompts use off to disable it. Read any card with forge prompts show <id>.",
      "Master\n  master",
      `Roles\n${data.roles.map((c) => `  ${c.id}  ${c.title}`).join("\n")}`,
      `Specialist prompts\n${data.pains.map((c) => `  ${c.id}  ${c.title}`).join("\n")}`,
    ].join("\n\n");
  } else if (cmd === "show" && positionals.length === 2) {
    const profile = values.profile ?? activePromptProfile(root);
    data = showDevelopmentPrompt(
      arg,
      profile === "off" && !values.profile ? "engineering" : profile,
    );
    text = [
      data.title,
      data.prompt,
      `Evidence to return: ${data.proof}`,
      ...(data.principles ?? []).map(
        (p) => `${p.concept}${p.reference ? ` (${p.reference})` : ""} — ${p.application}`,
      ),
    ].join("\n\n");
  } else if (cmd === "use" && positionals.length === 2) {
    data = selectPromptProfile(root, arg);
    text = `Personal prompt profile for this worktree: ${data.profile}`;
  } else if (cmd === "status" && positionals.length === 1) {
    data = promptStatus(root);
    text = `Personal prompt profile for this worktree: ${data.profile}`;
  } else
    throw new Error(
      "Use forge prompts list, status, use <profile|off> or show <id> [--profile engineering|quran]",
    );
  console.log(values.json ? JSON.stringify(data, null, 2) : text);
}
