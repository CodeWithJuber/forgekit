// forge CLI — `forge memory`: the five Jev memory layers (src/jev_memory.js,
// src/jev_skills.js). Presentation only: every layer's data comes from memoryDryRun
// (src/jev_memory_tools.js), the same entry point the forge_memory_decide MCP tool uses.
// Nothing runs at import time. Every form but `skills --apply|--remove` and
// `forget --apply` is a dry run: it asks the question the hooks ask and reports what
// would happen, without changing what is stored.
import { BRAND, heading, paint, table } from "./shared.js";

const pct = (x) => `${Math.round(x * 1000) / 10}%`;
const ms = (x) => (x == null ? "—" : `${x} ms`);
const pText = (p) => (p == null ? "—" : Number(p).toFixed(2));
const out = (x) => console.log(JSON.stringify(x, null, 2));

async function status(root, { json, llm }) {
  const jm = await import("../jev_memory.js");
  const { listLearnedSkills } = await import("../jev_skills.js");
  const st = jm.jevMemoryStatus(root, { llm });
  const stats = jm.summarizeJournal(jm.readJournal(root));
  const learned = listLearnedSkills(root).map((s) => s.slug);
  if (json) return out({ ...st, journal: stats, learned });
  heading(`${BRAND.brand} memory — Jev decides, the rubric stands in\n`);
  console.log(
    st.enabled ? `  jev: ${paint("on", "ok")}` : `  jev: ${paint("off", "warn")} — ${st.reason}`,
  );
  console.log(`  model: ${st.model} · journal: ${jm.journalPath(root)}`);
  console.log("");
  const rows = [["layer", "jev", "calls", "answered", "overrides", "median", "p95", "billed in"]];
  for (const l of jm.JEV_MEMORY_LAYERS) {
    const s = stats[l];
    rows.push([
      l,
      st.layers[l] ? "on" : "off",
      String(s.calls),
      String(s.answered),
      `${s.overrides}/${s.decisions}`,
      ms(s.ms.median),
      ms(s.ms.p95),
      String(s.billedIn),
    ]);
  }
  console.log(table(rows));
  console.log(`\n  learned skills: ${learned.length ? learned.join(", ") : "none"}`);
}

function renderWorking(r) {
  const m = r.memory;
  heading(`${BRAND.brand} memory admit — layer 1 (working)\n`);
  console.log(
    `  full memory: ${m.fullTokens} tokens (${m.memoryClaims} live memory claims + required context)`,
  );
  console.log(
    `  admitted:    ${m.admittedTokens} tokens — ${pct(m.reduction)} fewer (${r.tokenEstimate})`,
  );
  console.log(
    m.jev
      ? `  jev: asked ${m.jev.asked}, admitted ${m.jev.admitted}, dropped ${m.jev.dropped} in ${m.jev.ms} ms`
      : "  jev: off or no answer — the rubric's value-density selection",
  );
  console.log("");
  for (const s of r.selection) console.log(`    + ${s.id} [${s.gran}] ${s.tokens}t`);
}

function renderEpisodic(r) {
  heading(`${BRAND.brand} memory replay — layer 2 (episodic)\n`);
  if (!r.hits.length) return console.log("  no prior sessions, lessons or diagnoses to replay");
  r.hits.forEach((h, i) => {
    console.log(`  ${i}. rel ${h.rel.toFixed(2)} · ${h.id.slice(0, 8)} · ${h.text.slice(0, 100)}`);
  });
  console.log("");
  console.log(
    `  rubric: ${r.rubric.index >= 0 ? `replay #${r.rubric.index}` : `none above the relevance floor (${r.floor})`}`,
  );
  console.log(
    r.jev
      ? `  jev:    ${r.jev.index >= 0 ? `replay #${r.jev.index}` : "replay none"} (best p=${pText(r.jev.p)}, ${r.jev.ms} ms)`
      : "  jev:    off or no answer — the rubric decides",
  );
}

function renderSemantic(r) {
  heading(`${BRAND.brand} memory verify — layer 3 (semantic), dry run\n`);
  console.log(`  verdict: ${r.verdict} (${r.source}${r.p == null ? "" : `, p=${pText(r.p)}`})`);
  console.log(`  why:     ${r.reason}`);
  if (r.nearest)
    console.log(
      `  nearest: ${r.nearest.name ?? r.nearest.id.slice(0, 8)} — ${r.nearest.text.slice(0, 120)}`,
    );
}

async function renderProcedural(r, apply) {
  const { learnedPrefix } = await import("../jev_skills.js");
  heading(`${BRAND.brand} memory skills — layer 4 (procedural)${apply ? "" : ", dry run"}\n`);
  if (!r.proposals.length)
    console.log("  no recurring, test-confirmed work yet (needs ≥2 related sessions)");
  else {
    const rows = [["procedure", "sessions", "held-out pass", "rubric", "jev p", "action"]];
    for (const p of r.proposals)
      rows.push([
        p.slug,
        String(p.support),
        `${p.heldOut.pass}/${p.heldOut.pass + p.heldOut.fail}`,
        p.rubric.keep ? "keep" : "no",
        pText(p.jev),
        p.action,
      ]);
    console.log(table(rows));
  }
  if (r.installed.length)
    console.log(
      `\n  installed: ${r.installed.map((s) => `${learnedPrefix()}${s}`).join(", ")} → .claude/skills/`,
    );
  console.log(`  learned skills: ${r.learned.length}/${r.cap}`);
}

function renderForgetting(r, apply, pruned) {
  heading(`${BRAND.brand} memory forget — layer 5 (forgetting)${apply ? "" : ", dry run"}\n`);
  if (!r.archive.length) console.log("  nothing to archive");
  for (const a of r.archive) console.log(`  - ${a.id.slice(0, 8)} [${a.cause}] ${a.reason}`);
  console.log(
    r.judged
      ? `\n  jev: kept ${r.judged.vetoed.length} the rubric would archive, archived ${r.judged.added.length} more (${r.judged.ms} ms)`
      : "\n  jev: off or no answer — the rubric's retention plan",
  );
  console.log(
    apply
      ? `  archived ${pruned?.length ?? 0} to the attic (reversible: new evidence restores a claim)`
      : `  dry run — \`${BRAND.cli} memory forget --apply\` archives these`,
  );
}

const LAYER_OF = {
  admit: "working",
  replay: "episodic",
  verify: "semantic",
  skills: "procedural",
  forget: "forgetting",
};

/** `forge memory [status|admit|replay|verify|skills|forget]`. @param {string[]} argv */
export async function handleMemory(argv) {
  const { checkArgs } = await import("./args.js");
  const { memoryDryRun } = await import("../jev_memory_tools.js");
  const root = process.cwd();
  const parsed = checkArgs("memory", argv);
  const values = parsed?.values ?? {};
  const positionals = parsed?.positionals ?? [];
  const sub = parsed?.sub ?? "status";
  const text = positionals
    .slice(positionals[0] === sub ? 1 : 0)
    .join(" ")
    .trim();
  const json = values.json === true;
  const llm = values.llm === true ? true : undefined;
  const apply = values.apply === true;
  if (sub === "status" || !LAYER_OF[sub]) return status(root, { json, llm });
  const needsText = { admit: '"<task>"', replay: '"<task>"', verify: '"<fact>"' };
  if (needsText[sub] && !text) {
    console.error(`usage: ${BRAND.cli} memory ${sub} ${needsText[sub]}`);
    process.exitCode = 1;
    return;
  }
  if (sub === "skills" && typeof values.remove === "string") {
    const { removeLearnedSkill } = await import("../jev_skills.js");
    const r = removeLearnedSkill(root, values.remove);
    if (json) out(r);
    else console.log(r.ok ? `  removed learned skill ${r.slug}` : `  ${r.reason}`);
    if (!r.ok) process.exitCode = 1;
    return;
  }
  const r = await memoryDryRun(root, LAYER_OF[sub], {
    task: text,
    fact: text,
    name: typeof values.name === "string" ? values.name : "",
    llm,
    budget: values.budget ? Number(values.budget) : undefined,
    apply: sub === "skills" && apply,
  });
  let pruned = null;
  if (sub === "forget" && apply) {
    // Apply exactly the plan just shown (no second Jev call): the judge hands it back.
    const store = await import("../ledger_store.js");
    const { epochDay } = await import("../util.js");
    const dir = store.repoLedger(root);
    pruned = store.pruneLedger(dir, epochDay(), {
      judge: (_c, plan) => ({ ...plan, archive: r.archive }),
    }).pruned;
    store.reindex(dir, epochDay());
  }
  if (json) return out(sub === "forget" ? { ...r, applied: apply, pruned } : r);
  if (sub === "admit") return renderWorking(r);
  if (sub === "replay") return renderEpisodic(r);
  if (sub === "verify") return renderSemantic(r);
  if (sub === "skills") return renderProcedural(r, apply);
  return renderForgetting(r, apply, pruned);
}
