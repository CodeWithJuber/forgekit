"""Assumption / uncertainty gate (mechanism M2).

The root cause the user named: "The biggest problem is 'Assumption'. If it doesn't
have enough context it will assume many things." A frozen LLM maximizes P(next token
| context); when the context under-determines the task, the least-improbable
continuation is still *a* continuation, so the model fills the gap with a confident
guess rather than stopping to ask. There is no built-in signal that says "I am now
extrapolating past what you told me."

This gate supplies that missing signal. Before a task is executed, it scores the
request's SPECIFICATION COMPLETENESS across named dimensions, detects the specific
gaps, and -- when the request is under-specified past a threshold -- HALTS and emits
the concrete clarifying questions to ask. Asking one question is far cheaper than the
"almost right, but not quite" rework loop (field evidence: 66% of developers hit
that, and debugging the wrong-assumption output costs more than writing it).

Like the router, the gate is TRANSPARENT: every point of missing-spec is attributed
to a named, auditable dimension. It does not outsource the judgment to another opaque
model call. This is the paper's verify-before-acting principle (Qur'an 49:6, tabayyun:
"if a source brings you news, verify it") turned into a control-flow gate.
"""
from __future__ import annotations
from dataclasses import dataclass, field
import re


# Each dimension is a facet of "did you actually tell me enough to not guess?"
# A dimension is UNMET if none of its cue patterns appear AND the task plausibly
# needs it. We keep this conservative: only flag gaps that would force a real
# assumption, not stylistic vagueness.

@dataclass
class GapDimension:
    key: str
    description: str
    question: str          # what to ask the human if this is missing
    cues: object           # compiled regex of phrases that would SATISFY this dimension
    applies: object        # compiled regex: task looks like it NEEDS this dimension


def _c(p):
    return re.compile(p, re.I)


# Dimensions carry a `blocking` flag: a missing BLOCKING dimension forces a real
# assumption (you literally cannot proceed without guessing). Non-blocking gaps
# lower the completeness score but do not, alone, trigger a halt.
DIMENSIONS = [
    GapDimension(
        "inputs_outputs",
        "the exact input/output behavior (an example or expected return)",
        "What are the exact input and output (types, an example, or the expected return value)?",
        _c(r"(->|=>|:\s*\S)|\b(input|output|returns?|given|example|e\.g\.|for example|"
           r"such as|format|json|csv|schema|signature|expected)\b|```"),
        _c(r"\b(function|api|endpoint|parse|convert|transform|read|write|generate|compute|return|implement)\b"),
    ),
    GapDimension(
        "target_scope",
        "which file / module / component to change is identified",
        "Which specific file, module, or component should this change touch?",
        _c(r"\b(file|module|class|function|component|path|directory|service|layer|endpoint)\b|`[\w./]+`|\w+\.\w+"),
        # only applies to CHANGE tasks (fix/edit/refactor existing code), not fresh writes
        _c(r"\b(fix|change|edit|update|modify|refactor|add to|remove from|integrate|wire|the (bug|issue|error))\b"),
    ),
    GapDimension(
        "success_criteria",
        "how 'done' will be judged (a test, criterion, or reference behavior)",
        "How will we know it's correct -- a test, an acceptance criterion, or a reference behavior?",
        _c(r"(->|=>)|\b(test|passes|acceptance|criteri|expected|should (return|equal|match|be)|"
           r"verif|assert|benchmark|correct when|e\.g\.|example)\b|```"),
        _c(r"\b(fix|optimi[sz]e|make it (faster|work|better)|improve|ensure|feature|behavior)\b"),
    ),
    GapDimension(
        "constraints",
        "hard constraints (perf, deps, style, compatibility)",
        "Are there constraints I must respect (performance, allowed dependencies, style, backward-compat)?",
        _c(r"\b(must|should|constraint|limit|no (new )?dependenc|only use|standard library|"
           r"without|performance|latency|O\(|backward|compatib|convention|style)\b"),
        # only applies to larger build/design tasks
        _c(r"\b(design|architect|production|scal|migrate|distributed|concurren|refactor)\b"),
    ),
]

# which dimensions, if missing, actually FORCE an assumption (=> can trigger a halt)
_BLOCKING = {"inputs_outputs", "target_scope", "success_criteria"}

# Words that themselves SIGNAL under-specification (raise the assumption risk).
_VAGUE = _c(r"\b(some|somehow|etc|and so on|things?|stuff|appropriate(ly)?|as needed|"
            r"handle (it|everything)|make it (work|better|nice|good)|clean it up|"
            r"cleaner|the usual|standard way|properly|correctly|the way we "
            r"(discussed|talked)|like before|as before)\b")
# A concrete example lowers risk sharply.
_HAS_EXAMPLE = _c(r"\b(e\.g\.|for example|such as|like this|input:|output:)\b|```")

# CONCRETENESS ANCHORS -- any of these means the request carries actionable detail:
# a code fence, an arrow example, a call signature f(x, y), a quoted literal, a
# filename.ext, a numeric example, or an explicit example marker.
_ANCHORS = [
    _c(r"```"),                          # code block
    _c(r"->|=>"),                        # example / mapping arrow
    _c(r"\b\w+\([^)]*\)"),               # call signature: is_prime(n), put(key, value)
    _c(r"'[^']+'|\"[^\"]+\""),           # quoted literal
    _c(r"\b\w+\.\w{1,4}\b"),             # filename.ext (e.g. utils.py) -- short ext
    _c(r"\b\d+\b.*(->|=>|=|:)|\(\d"),    # a number tied to an example
    _c(r"\b(e\.g\.|for example|such as|example:)\b"),
]
# Named tech/algorithm specifics raise information content (a real spec, even in prose).
_SPECIFIC = _c(r"\b(python|javascript|typescript|java|rust|golang|react|django|flask|node|redis|sql|postgres|asyncio|dijkstra|lru|adjacency|owasp|regex)\b|token-?bucket|binary heap|condition[- ]variable|recursive-?descent|in-?order|standard library|o\(\s*\d|o\(n|o\(1")


def _concreteness(t: str) -> int:
    return sum(1 for a in _ANCHORS if a.search(t))

def _specificity(t: str) -> int:
    return len(set(m.group(0).lower() for m in _SPECIFIC.finditer(t)))


@dataclass
class AssumptionReport:
    completeness: float               # 0..1, higher = better specified
    risk: str                         # "low" | "medium" | "high"
    should_ask: bool                  # HALT and ask before executing?
    missing: list = field(default_factory=list)     # [(key, description)]
    questions: list = field(default_factory=list)   # concrete questions to ask
    reasons: list = field(default_factory=list)     # attributions

    def explain(self) -> str:
        head = (f"completeness={self.completeness:.2f}  risk={self.risk}  "
                f"should_ask={self.should_ask}")
        body = "\n".join(f"  - {r}" for r in self.reasons)
        qs = "\n".join(f"  ? {q}" for q in self.questions)
        return head + ("\n" + body if body else "") + (("\nQuestions to ask:\n" + qs) if qs else "")


def assess(task: str, *, ask_threshold: float = 0.6) -> AssumptionReport:
    """Score specification completeness and decide whether to halt-and-ask.

    ask_threshold: if completeness < threshold, the gate recommends asking rather
    than executing. 0.6 is deliberately cautious for coding tasks, where a wrong
    assumption is expensive; callers can loosen it for low-stakes work.
    """
    t = task or ""
    reasons, missing, questions = [], [], []
    words = len(t.split())

    # --- information-content measures (the decision driver) ---
    conc = _concreteness(t)
    spec = _specificity(t)
    vague_hits = len(set(m.group(0).lower() for m in _VAGUE.finditer(t)))

    # completeness in [0,1]: earned by concrete anchors and named specifics,
    # eroded by vague fillers and extreme brevity.
    base = 0.45
    base += min(0.45, 0.18 * conc)
    base += min(0.20, 0.06 * spec)
    base -= 0.22 * vague_hits
    if words <= 7:
        base -= 0.22
        reasons.append("very short request (little information)")
    # A long, detailed request carries information in its prose even without a code
    # example: many words + several named specifics is a real spec, not a guess-magnet.
    if words >= 30 and spec >= 2:
        base += 0.20
        reasons.append(f"long detailed spec ({words} words, {spec} named specifics)")
    elif words >= 22 and spec >= 1:
        base += 0.10
        reasons.append(f"detailed spec ({words} words)")
    if conc:
        reasons.append(f"{conc} concrete anchor(s) (example/signature/literal)")
    if spec:
        reasons.append(f"{spec} named technical specific(s)")
    if vague_hits:
        reasons.append(f"{vague_hits} vague filler(s) that force interpretation")

    completeness = max(0.0, min(1.0, base))

    # --- identify WHICH dimensions are missing, to generate good questions ---
    blocking_missing = 0
    for d in DIMENSIONS:
        if not d.applies.search(t):
            continue
        if not d.cues.search(t):
            missing.append((d.key, d.description))
            is_blocking = d.key in _BLOCKING
            if is_blocking:
                blocking_missing += 1
            questions.append((0 if is_blocking else 1, d.question))

    # --- the halt rule: proceed only if the request carries enough information ---
    # Under-specified iff completeness is below threshold. Two decisive patterns:
    #   (a) short & no concrete anchor  -> "Fix the bug." / "Optimize it."
    #   (b) vague filler & no anchor    -> "handle everything appropriately"
    hard_underspecified = (conc == 0) and (words <= 10 or (vague_hits >= 1 and spec == 0))
    should_ask = (completeness < ask_threshold) or hard_underspecified
    risk = "high" if completeness < 0.45 else ("medium" if completeness < 0.7 else "low")
    if hard_underspecified and not any("short" in r or "vague" in r for r in reasons):
        reasons.append("no concrete anchor to act on")

    # order questions: blocking first, then the rest; cap at 3
    questions = [q for _, q in sorted(questions, key=lambda x: x[0])]
    # if nothing dimension-specific surfaced but we're asking, give a general prompt
    if should_ask and not questions:
        questions = ["What exactly should this produce, and how will we know it's correct?"]

    # cap questions to the 3 most load-bearing to avoid an interrogation
    return AssumptionReport(
        completeness=completeness, risk=risk, should_ask=should_ask,
        missing=missing, questions=questions[:3], reasons=reasons,
    )
