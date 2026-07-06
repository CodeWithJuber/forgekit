import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { adjudicate, asText, asUnit, extractJson, llmEnabled } from "../src/adjudicate.js";

const parseScore = (o) => {
  const score = asUnit(o.score);
  return score == null ? null : { score, reason: asText(o.reason) };
};

afterEach(() => {
  delete process.env.FORGE_LLM;
});

test("llmEnabled: explicit opt wins over env", () => {
  process.env.FORGE_LLM = "1";
  assert.equal(llmEnabled({ llm: false }), false);
  delete process.env.FORGE_LLM;
  assert.equal(llmEnabled({ llm: true }), true);
});

test("llmEnabled: env is the default, off unless exactly '1'", () => {
  assert.equal(llmEnabled(), false);
  process.env.FORGE_LLM = "0";
  assert.equal(llmEnabled(), false);
  process.env.FORGE_LLM = "1";
  assert.equal(llmEnabled(), true);
});

test("extractJson: pulls a JSON object out of chatty output, tolerates garbage", () => {
  assert.deepEqual(extractJson('sure! {"score":0.4} done'), { score: 0.4 });
  assert.equal(extractJson("no json here"), null);
  assert.equal(extractJson("{not valid}"), null);
  assert.equal(extractJson(""), null);
});

test("adjudicate: happy path returns the validated proposal", () => {
  const run = () => '{"score": 0.42, "reason": "some detail"}';
  assert.deepEqual(adjudicate({ prompt: "x", parse: parseScore, run }), {
    score: 0.42,
    reason: "some detail",
  });
});

test("adjudicate: garbage / unparseable reply → null (caller keeps deterministic)", () => {
  assert.equal(adjudicate({ prompt: "x", parse: parseScore, run: () => "nope" }), null);
  assert.equal(
    adjudicate({
      prompt: "x",
      parse: parseScore,
      run: () => '{"score":"not-a-number"}',
    }),
    null,
  );
});

test("adjudicate: a throwing runner (CLI missing / timeout) → null, never throws", () => {
  const run = () => {
    throw new Error("claude not found");
  };
  assert.equal(adjudicate({ prompt: "x", parse: parseScore, run }), null);
});

test("adjudicate: refuses to send a secret in the prompt", () => {
  let called = false;
  const run = () => {
    called = true;
    return '{"score":0.5}';
  };
  const secret = ["sk-ant", "abcd1234efgh5678ijkl"].join("-");
  assert.equal(adjudicate({ prompt: `use ${secret}`, parse: parseScore, run }), null);
  assert.equal(called, false, "runner must not be invoked when the prompt carries a secret");
});

test("adjudicate: refuses a reply that leaks a secret back", () => {
  const secret = ["ghp", "abcdefghij0123456789"].join("_");
  const run = () => `{"score":0.5,"reason":"${secret}"}`;
  assert.equal(adjudicate({ prompt: "clean", parse: parseScore, run }), null);
});

test("adjudicate: a task that merely mentions password/secret still runs (not gutted)", () => {
  // Regression for the over-broad SECRET_RE word match: these prompts carry no assigned value,
  // so the proposer must actually run rather than silently fall back to deterministic.
  let calls = 0;
  const run = () => {
    calls++;
    return '{"score":0.4,"reason":"ok"}';
  };
  assert.ok(
    adjudicate({ prompt: "implement password hashing in auth.js", parse: parseScore, run }),
  );
  assert.ok(
    adjudicate({
      prompt: "rotate the api key helper and the secret loader",
      parse: parseScore,
      run,
    }),
  );
  assert.equal(calls, 2, "the model ran for both auth-related prompts");
});

test("asUnit clamps to [0,1]; asText trims and caps", () => {
  assert.equal(asUnit(1.7), 1);
  assert.equal(asUnit(-3), 0);
  assert.equal(asUnit("0.3"), 0.3);
  assert.equal(asUnit("x"), null);
  assert.equal(asText("  hi  "), "hi");
  assert.equal(asText(null), "");
  assert.equal(asText("x".repeat(500)).length, 200);
});
