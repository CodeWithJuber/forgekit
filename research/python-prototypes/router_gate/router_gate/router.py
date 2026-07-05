"""Complexity-aware model router (mechanism M1).

The failure this attacks, in the user's words: "a simple prime number finder ...
if you use [a premium model] it will not give you extra [value]." A frozen LLM is a
probability engine billed per token; sending a trivial task to the premium tier is
pure waste of tokens, time, and money. The router scores a task's intrinsic
complexity and sends it to the CHEAPEST tier likely to succeed, escalating only on
evidence of failure.

Design commitment (the user's core value: never blindly trust a probability engine):
the routing decision is a TRANSPARENT, feature-based rubric that explains itself. It
does not ask another opaque LLM "how hard is this?" -- that would just move the
untrusted probability one level up. Every point of the score is attributable to a
named feature, so a human can audit and override it.

Escalation is the safety valve. Cheap-tier output is checked by an external verifier
(a test, a compile, a regex, or a caller-supplied predicate). Only if that check
FAILS do we spend a higher tier -- so the worst case is 'cheap attempt + premium
attempt', and the common case is 'cheap only'. This mirrors the paper's central
move: trust is earned by an EXTERNAL check, not asserted by the model.
"""
from __future__ import annotations
from dataclasses import dataclass, field
import re
from .pricing import DEFAULT_LADDER, TIER_ORDER, tier_by_name


# ---- complexity signals -----------------------------------------------------
# Each signal contributes points to a 0..~12 raw score, then banded to a tier.
# Signals are intentionally simple and inspectable; the weights are the rubric.

# HARD signals: genuine algorithmic / systems difficulty (premium-worthy).
_ALGO_TERMS = re.compile(r"\b(recursion|recursive|recursive-?descent|dynamic "
                         r"programming|dijkstra|a\*|concurren|thread-?safe|mutex|"
                         r"race condition|deadlock|distributed|consensus|parser|"
                         r"compiler|cryptograph|np-hard|state machine|invariant|"
                         r"numerical stability|back-?pressure|token[- ]bucket|"
                         r"rate limiter|idempoten|migration|producer|consumer|"
                         r"blocking queue|condition[- ]variable)", re.I)
# ARCHITECTURAL signals: design/whole-system scope (premium-worthy).
_ARCH_TERMS = re.compile(r"\b(architect|\bdesign\b|trade-?off|refactor a|migrate|"
                         r"scal(e|able|ing)|schema (migration|design)|api design|"
                         r"multi-?module|cross-?module|end-?to-?end|consistency "
                         r"(guarantee|trade)|locking strategy|module boundaries)", re.I)
# MODERATE signals: data-structure / class / library-level work (mid-worthy).
_MODERATE_TERMS = re.compile(r"\b(class\b|cache|lru|queue|stack|heap|linked list|"
                             r"binary tree|tree|traversal|graph|decorator|regex|"
                             r"debounce|throttle|merge|sort(ed|ing)?|parse|"
                             r"o\(\s*\d|o\(n|o\(1|thread|async|lock|validate|"
                             r"in-?order|adjacency)", re.I)
# TRIVIAL markers: one-liner tells (pull the score DOWN).
_TRIVIAL_TERMS = re.compile(r"\b(hello world|rename|typo|indent|add a comment|"
                            r"reverse a string|reverse the string|is[_ ]?even|"
                            r"is[_ ]?odd|factorial|fibonacci|is[_ ]?prime|prime\b|"
                            r"sum of|sum_list|capitalize|count vowels|celsius|"
                            r"fahrenheit|lower ?case|upper ?case)", re.I)
_MULTISTEP = re.compile(r"\b(and then|after that|first.*then|step \d|"
                        r"multiple|several|each of|for every)\b", re.I)
_CODEFENCE = re.compile(r"```")


@dataclass
class ComplexitySignals:
    length_tokens: int
    has_algorithmic_terms: bool
    has_architectural_terms: bool
    has_moderate_terms: bool
    has_trivial_markers: bool
    has_multistep: bool
    has_code_context: bool
    n_constraints: int          # counted "must"/"should"/"ensure"/bullet lines


@dataclass
class RoutingDecision:
    tier: str                   # "cheap" | "mid" | "premium"
    score: float                # raw complexity score
    signals: ComplexitySignals
    reasons: list = field(default_factory=list)   # human-readable attributions

    def explain(self) -> str:
        head = f"tier={self.tier}  score={self.score:.1f}"
        return head + "\n" + "\n".join(f"  +{w:.1f}  {why}" for w, why in self.reasons)


def _approx_tokens(text: str) -> int:
    # cheap, dependency-free approximation (~4 chars/token)
    return max(1, len(text) // 4)


def extract_signals(task: str) -> ComplexitySignals:
    t = task or ""
    n_constraints = len(re.findall(r"(?im)^\s*[-*\d.]|\b(must|should|ensure|require|constraint)\b", t))
    return ComplexitySignals(
        length_tokens=_approx_tokens(t),
        has_algorithmic_terms=bool(_ALGO_TERMS.search(t)),
        has_architectural_terms=bool(_ARCH_TERMS.search(t)),
        has_moderate_terms=bool(_MODERATE_TERMS.search(t)),
        has_trivial_markers=bool(_TRIVIAL_TERMS.search(t)),
        has_multistep=bool(_MULTISTEP.search(t)),
        has_code_context=bool(_CODEFENCE.search(t)),
        n_constraints=n_constraints,
    )


def score_complexity(sig: ComplexitySignals):
    """Return (raw_score, reasons[]). Transparent additive rubric.

    Bands (see `band`): score < 3 -> cheap, 3..6 -> mid, > 6 -> premium.
    Weights are the policy; every one is attributed in `reasons` for audit.
    """
    reasons = []
    score = 1.5
    reasons.append((1.5, "base cost of any task"))

    # HARD signals dominate -> push to premium.
    if sig.has_algorithmic_terms:
        score += 4.0; reasons.append((4.0, "algorithmic/systems difficulty (concurrency, parsing, distributed, ...)"))
    if sig.has_architectural_terms:
        score += 4.0; reasons.append((4.0, "architectural/design scope (whole-system, migration, trade-offs)"))

    # MODERATE signals -> lift into the mid band.
    if sig.has_moderate_terms:
        score += 2.0; reasons.append((2.0, "data-structure/class/library-level work"))

    # secondary difficulty signals
    if sig.has_multistep:
        score += 1.0; reasons.append((1.0, "multi-step / sequenced request"))
    if sig.has_code_context:
        score += 1.0; reasons.append((1.0, "carries code context to reason over"))
    if sig.length_tokens > 120:
        score += 1.5; reasons.append((1.5, f"long spec (~{sig.length_tokens} tok)"))
    elif sig.length_tokens > 55:
        score += 0.7; reasons.append((0.7, f"medium spec (~{sig.length_tokens} tok)"))
    if sig.n_constraints >= 5:
        score += 1.0; reasons.append((1.0, f"{sig.n_constraints} explicit constraints to satisfy"))

    # trivial markers pull DOWN hard: a strong tell the task is a one-liner.
    # (Suppressed when hard signals fire, so 'prime-factorization consensus' isn't miscounted.)
    if sig.has_trivial_markers and not sig.has_algorithmic_terms and not sig.has_architectural_terms:
        score -= 3.0; reasons.append((-3.0, "trivial-task marker (prime/factorial/reverse/rename)"))

    return max(0.0, score), reasons


def band(score: float) -> str:
    """Map a raw complexity score to a tier band. Thresholds are the policy knob."""
    if score < 3.0:
        return "cheap"
    if score <= 6.0:
        return "mid"
    return "premium"


def route(task: str) -> RoutingDecision:
    sig = extract_signals(task)
    score, reasons = score_complexity(sig)
    return RoutingDecision(tier=band(score), score=score, signals=sig, reasons=reasons)


def next_tier(tier: str):
    """The next tier up for escalation, or None if already at premium."""
    i = TIER_ORDER.index(tier)
    return TIER_ORDER[i + 1] if i + 1 < len(TIER_ORDER) else None
