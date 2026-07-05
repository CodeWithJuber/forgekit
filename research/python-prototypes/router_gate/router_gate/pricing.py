"""Model tiers and cost accounting.

A frozen LLM is a probability engine priced by the token. The whole point of
complexity-aware routing is economic: do not pay premium-tier rates for a task a
cheap tier handles correctly. To reason about that honestly we need (a) a tier
ladder and (b) real per-token prices.

Prices below are APPROXIMATE public list prices (USD per million tokens) for the
Anthropic 4.x generation, as of mid-2026. They are deliberately overridable: the
mechanism does not depend on the exact numbers, only on the ratio between tiers.
Every cost figure this package reports is arithmetic on measured token counts and
these constants -- never a guess.
"""
from __future__ import annotations
from dataclasses import dataclass


@dataclass(frozen=True)
class Tier:
    """One model tier: a name, the concrete model id, and its price."""
    name: str            # "cheap" | "mid" | "premium"
    model_id: str        # concrete id passed to host.llm(model=...)
    usd_in_per_mtok: float
    usd_out_per_mtok: float

    def cost(self, input_tokens: int, output_tokens: int) -> float:
        """USD cost of a call given measured token counts."""
        return (input_tokens / 1e6) * self.usd_in_per_mtok + \
               (output_tokens / 1e6) * self.usd_out_per_mtok


# The tier ladder. model_id values are resolved at runtime against host.list_models()
# (see ladder_from_available); these defaults match the 4.x generation seen in 2026.
DEFAULT_LADDER = [
    Tier("cheap",   "claude-haiku-4-5-20251001", usd_in_per_mtok=1.0,  usd_out_per_mtok=5.0),
    Tier("mid",     "claude-sonnet-5",           usd_in_per_mtok=3.0,  usd_out_per_mtok=15.0),
    Tier("premium", "claude-opus-4-8",           usd_in_per_mtok=15.0, usd_out_per_mtok=75.0),
]

# Order of complexity bands, lowest first. The router emits one of these.
TIER_ORDER = ["cheap", "mid", "premium"]


def ladder_from_available(available_model_ids, ladder=None):
    """Adapt the default ladder to whatever models actually exist in this session.

    Keeps each tier's price but swaps in a concrete model_id that is present in
    `available_model_ids`, matching by family prefix (haiku/sonnet/opus). This makes
    the prototype portable across sessions where exact ids differ, without pretending
    a model exists that does not.
    """
    ladder = ladder or DEFAULT_LADDER
    fam = {"cheap": "haiku", "mid": "sonnet", "premium": "opus"}
    ids = list(available_model_ids or [])
    out = []
    for t in ladder:
        want = fam[t.name]
        # exact id first, else first available id whose name contains the family
        pick = t.model_id if t.model_id in ids else next((m for m in ids if want in m), t.model_id)
        out.append(Tier(t.name, pick, t.usd_in_per_mtok, t.usd_out_per_mtok))
    return out


def tier_by_name(ladder, name: str) -> Tier:
    for t in ladder:
        if t.name == name:
            return t
    raise KeyError(name)
