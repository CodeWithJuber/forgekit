#!/usr/bin/env node
// The receipt compares all inputs with the last accepted regeneration on master.
// Looking only at the last push loses pending changes when a proposal has not merged.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOSTS } from "../src/hosts.js";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const receiptPath = "docs/assets/media-receipts.json";
const shared = [
  "scripts/docs-media.mjs",
  "scripts/docs-media/setup.sh",
  "scripts/docs-media/requirements.txt",
];
const python = process.env.FORGE_MEDIA_PYTHON || "python3";
const digest = (data) => createHash("sha256").update(data).digest("hex");
const outputs = {
  demos: [
    "docs/assets/demo.gif",
    "mintlify/images/supervised-setup.gif",
    ".github/assets/forgekit-verify.gif",
    ".github/assets/forgekit-precommit.gif",
    ".github/assets/forgekit-memory.gif",
    "mintlify/images/cost-governance.gif",
    "mintlify/images/adversarial-doctor.gif",
  ],
  hero: ["docs/assets/hero-light.svg", "docs/assets/hero-dark.svg"],
  social: [
    "docs/assets/og.jpg",
    ".github/assets/social-preview.png",
    "mintlify/images/og-image.png",
  ],
  dashboard: ["docs/assets/dashboard.png", "mintlify/images/dashboard.png"],
};
const runtime =
  /^(?:src\/|global\/|source\/|hooks\/|templates\/|data\/|package(?:-lock)?\.json$|kimi\.plugin\.json$|\.codex-plugin\/|\.claude-plugin\/)/;
const inputs = {
  demos: (f) => runtime.test(f) || /^(?:brand\.json|scripts\/make-.*-gif\.py)$/.test(f),
  hero: (f) => ["brand.json", "src/hosts.js", "scripts/docs-media/hero.svg.tpl"].includes(f),
  social: (f) =>
    [
      "brand.json",
      "docs/assets/og.svg",
      "docs/assets/og-background.webp",
      "scripts/og-card.mjs",
      "scripts/make-social-images.py",
      "scripts/diagrams.mjs",
    ].includes(f),
  dashboard: (f) =>
    runtime.test(f) ||
    ["brand.json", "scripts/dashboard-preview.mjs", "scripts/diagrams.mjs"].includes(f),
};

export function mediaPlan(root = repo) {
  const filenames = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  const prior = existsSync(path.join(root, receiptPath))
    ? JSON.parse(readFileSync(path.join(root, receiptPath), "utf8"))
    : {};
  const hashes = new Map();
  const fileHash = (id) => {
    if (!hashes.has(id)) {
      const file = path.join(root, id);
      hashes.set(id, existsSync(file) ? digest(readFileSync(file)) : null);
    }
    return hashes.get(id);
  };
  const current = {},
    stale = [];
  for (const [group, targets] of Object.entries(outputs)) {
    const names = [...new Set(filenames.filter(inputs[group]).concat(shared))].sort();
    const input = digest(JSON.stringify(names.map((id) => [id, fileHash(id)])));
    const artifacts = Object.fromEntries(targets.map((id) => [id, fileHash(id)]));
    current[group] = { input, artifacts };
    if (
      Object.values(artifacts).includes(null) ||
      JSON.stringify(current[group]) !== JSON.stringify(prior[group])
    )
      stale.push(group);
  }
  return { current, stale };
}

function generateHeroes(root) {
  const brand = JSON.parse(readFileSync(path.join(root, "brand.json"), "utf8"));
  const template = readFileSync(path.join(root, "scripts/docs-media/hero.svg.tpl"), "utf8");
  const xml = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const labels = [...Object.values(HOSTS).map((h) => h.label), "Generic MCP"];
  const rowHeight = 80 / Math.max(1, Math.ceil(labels.length / 2) - 1);
  const hostElements = labels
    .map(
      (label, i) =>
        `      <text x="${20 + 94 * (i % 2)}" y="${Math.round(72 + rowHeight * Math.floor(i / 2))}">${xml(label)}</text>`,
    )
    .join("\n");
  for (const theme of ["light", "dark"]) {
    const tokens = {
      ...brand.colors[theme],
      hosts: hostElements,
      "on-brand": theme === "light" ? "#ffffff" : brand.colors.dark.bg,
    };
    const svg = template.replace(/\{\{([\w-]+)\}\}/g, (_, k) => {
      if (!Object.hasOwn(tokens, k)) throw new Error(`Unknown hero template token: ${k}`);
      return tokens[k];
    });
    writeFileSync(path.join(root, `docs/assets/hero-${theme}.svg`), svg);
  }
}

export function buildMedia(
  root = repo,
  render = (group) => {
    const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: "inherit" });
    if (group === "hero") return generateHeroes(root);
    if (group === "demos") return run(python, ["scripts/make-demo-gif.py"]);
    if (group === "social") {
      run(python, ["scripts/make-social-images.py"]);
      return run(process.execPath, ["scripts/og-card.mjs"]);
    }
    return run(process.execPath, ["scripts/dashboard-preview.mjs"]);
  },
) {
  const plan = mediaPlan(root);
  if (!plan.stale.length) return plan;
  for (const group of plan.stale) render(group);
  const result = mediaPlan(root);
  for (const [name, group] of Object.entries(result.current)) {
    if (Object.values(group.artifacts).includes(null))
      throw new Error(`Missing output from ${name} render`);
    if (plan.current[name].input !== group.input)
      throw new Error(`Inputs changed during ${name} render`);
  }
  const file = path.join(root, receiptPath),
    temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(result.current, null, 2)}\n`, { flag: "wx" });
  renameSync(temp, file);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action] = process.argv.slice(2);
  if (action === "build") buildMedia();
  else if (action === "outputs") {
    process.stdout.write(`${[receiptPath, ...Object.values(outputs).flat()].join("\n")}\n`);
  } else if (action === "hero") generateHeroes(repo);
  else if (action === "plan" || action === "check") {
    const { stale } = mediaPlan();
    console.log(stale.join(" "));
    if (action === "check" && stale.length) process.exitCode = 1;
  } else throw new Error("Use plan, check, build, hero, or outputs");
}
