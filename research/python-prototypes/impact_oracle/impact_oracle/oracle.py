"""Impact Oracle: blast-radius prediction for symbol changes.

Given a world-model graph and a proposed change to symbol X, the oracle
traverses *reverse* dependency edges (who imports/calls/inherits/references X)
to predict the set of symbols and files that would be affected.  Each
impacted node carries a decaying confidence score and the dependency path
that connects it to X.

CHANGES (defect-2 fix): the reverse-only traversal above is EXTENDED (not
replaced) with two additional, clearly-labeled relation types, each with its
own confidence treatment, hop cap, and (for siblings) a bridge in-degree cap.
See ImpactOracle's docstring and the module-level `SIBLING_*`/`FORWARD_*`
defaults below for the full rationale; the short version:

- SIBLING relation (fixes the dominant false-negative category, "sibling
  common dependency" = 94.7% of misses in the pre-repair diagnostic): A and
  B both depend on a shared module C (e.g. both `import json`), so they
  co-change when C's usage contract shifts, even though neither is
  reverse-reachable from the other. Reached by one bounded forward hop (to
  find C) then one bounded reverse hop from C (to find B) -- NOT chained
  recursively, and only through bridges C whose in-degree is below a cap
  (a shared dependency used by 3 files is strong sibling evidence; one used
  by 200 files is not -- almost everything is "similar" via a hub, and
  treating hub fan-in as an impact signal would tank precision).
- FORWARD relation (fixes "forward_only_blindspot" = 2.1% of misses): the
  changed symbol's OWN dependencies (successors) -- covers the case where
  editing a call site plausibly means updating the callee too. Reached by a
  small bounded forward walk from the changed symbol only (not from every
  node in the reverse tree, since this relation has no bridge-based
  precision guard to fall back on).

Both new relation types are TERMINAL: a node discovered via a sibling or
forward hop is scored and included in the impact report, but is never
itself re-expanded through the primary reverse BFS or through another
sibling/forward hop. This bounds the algorithm's fan-out to a small,
fixed multiple of the reverse-BFS frontier size regardless of graph
structure, which is what makes the in-degree cap sufficient to reason about
independent of graph size.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import networkx as nx

from impact_oracle.world_model import WorldModel


# Edge-kind weights: how strongly each dependency kind propagates impact.
EDGE_WEIGHTS: dict[str, float] = {
    "calls":      0.95,
    "imports":     0.90,
    "inherits":    0.92,
    "references":  0.70,
    "contains":    0.60,   # child → parent propagation is weaker
}

# Default per-hop decay factor
DEFAULT_DECAY = 0.85

# --- Defect-2 fix: new relation-type parameters -----------------------
# These are the FROZEN parameters: chosen by a 120-configuration grid search over the
# six TUNING repos only, written to the replication package's
# `protocol/FROZEN_PARAMETERS.json`, and never adjusted after the held-out repos were
# run (held-out: precision 0.320, recall 0.647, F1 0.428 vs grep's 0.371). Do not
# re-tune them here: the numbers in the paper are only meaningful at these values.

# SIBLING relation: A and B are "siblings" if both depend on a common node C.
DEFAULT_SIBLING_ENABLED = True
DEFAULT_SIBLING_WEIGHT = 0.7          # extra multiplicative dampening (sibling evidence is weaker than direct dependency)
DEFAULT_SIBLING_FORWARD_HOPS = 1      # how far to walk forward from the changed symbol to find bridge candidates
DEFAULT_SIBLING_REVERSE_HOPS = 1      # how far to walk reverse from a bridge to find siblings
DEFAULT_SIBLING_BRIDGE_MAX_INDEGREE = 100  # skip bridges more "popular" than this (hub modules give weak sibling evidence)

# FORWARD relation: the changed symbol's own transitive dependencies.
DEFAULT_FORWARD_ENABLED = True
DEFAULT_FORWARD_WEIGHT = 0.5          # extra multiplicative dampening relative to the reverse-direction formula
DEFAULT_FORWARD_MAX_HOPS = 2          # small cap: forward-only is a minority failure mode (2.1% of misses); deep forward chains are increasingly indirect


@dataclass
class ImpactedNode:
    """A single node in the predicted blast radius."""
    qualified_name: str
    kind: str              # node kind: module/class/function/name
    file: str
    confidence: float      # cumulative confidence [0, 1]
    hop_distance: int      # number of edges from the changed symbol
    path: list[str]        # sequence of qualified_names from changed → this
    edge_kinds: list[str]  # kind of each edge on the path
    # CHANGES (defect-2 fix): provenance of HOW this node was reached.
    # "reverse" = shipped behavior (who depends on the changed symbol).
    # "sibling" = shares a common dependency with the changed symbol.
    # "forward" = something the changed symbol itself depends on.
    # Purely diagnostic -- above_threshold() and impacted_files still work
    # exactly as before regardless of relation.
    relation: str = "reverse"

    def to_dict(self) -> dict[str, Any]:
        return self.__dict__.copy()


@dataclass
class ImpactReport:
    """Full result of an impact prediction."""
    changed_symbol: str
    impacted: list[ImpactedNode]
    impacted_files: list[str]
    threshold_used: float
    total_graph_nodes: int
    total_graph_edges: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "changed_symbol": self.changed_symbol,
            "impacted": [n.to_dict() for n in self.impacted],
            "impacted_files": self.impacted_files,
            "threshold_used": self.threshold_used,
            "total_graph_nodes": self.total_graph_nodes,
            "total_graph_edges": self.total_graph_edges,
        }

    def above_threshold(self, threshold: float | None = None) -> list[ImpactedNode]:
        """Return impacted nodes above a confidence threshold."""
        t = threshold if threshold is not None else self.threshold_used
        return [n for n in self.impacted if n.confidence >= t]


class ImpactOracle:
    """Predicts the blast radius of a proposed symbol change.

    Works by traversing *reverse* dependency edges in the world-model
    graph: starting from the changed symbol, it walks predecessors
    (nodes that depend on the changed symbol) with decaying confidence.

    CHANGES (defect-2 fix): also optionally traverses two more relation
    types -- SIBLING (shared-dependency co-change) and FORWARD (the changed
    symbol's own dependencies) -- each independently toggleable and with
    its own confidence treatment, so a caller who wants byte-identical
    as-shipped behavior can construct with `sibling_enabled=False,
    forward_enabled=False`. See module docstring for the full rationale.
    """

    def __init__(
        self,
        world_model: WorldModel,
        decay: float = DEFAULT_DECAY,
        edge_weights: dict[str, float] | None = None,
        max_hops: int = 10,
        sibling_enabled: bool = DEFAULT_SIBLING_ENABLED,
        sibling_weight: float = DEFAULT_SIBLING_WEIGHT,
        sibling_forward_hops: int = DEFAULT_SIBLING_FORWARD_HOPS,
        sibling_reverse_hops: int = DEFAULT_SIBLING_REVERSE_HOPS,
        sibling_bridge_max_indegree: int = DEFAULT_SIBLING_BRIDGE_MAX_INDEGREE,
        forward_enabled: bool = DEFAULT_FORWARD_ENABLED,
        forward_weight: float = DEFAULT_FORWARD_WEIGHT,
        forward_max_hops: int = DEFAULT_FORWARD_MAX_HOPS,
    ):
        self.wm = world_model
        self.decay = decay
        self.edge_weights = edge_weights or EDGE_WEIGHTS
        self.max_hops = max_hops
        self.sibling_enabled = sibling_enabled
        self.sibling_weight = sibling_weight
        self.sibling_forward_hops = sibling_forward_hops
        self.sibling_reverse_hops = sibling_reverse_hops
        self.sibling_bridge_max_indegree = sibling_bridge_max_indegree
        self.forward_enabled = forward_enabled
        self.forward_weight = forward_weight
        self.forward_max_hops = forward_max_hops

    def predict_impact(
        self,
        symbol: str,
        threshold: float = 0.1,
    ) -> ImpactReport:
        """Predict the blast radius of changing *symbol*.

        Parameters
        ----------
        symbol : str
            Qualified name of the symbol being changed.
        threshold : float
            Minimum confidence to include a node in the result.

        Returns
        -------
        ImpactReport
        """
        graph = self.wm.graph
        if symbol not in graph:
            return ImpactReport(
                changed_symbol=symbol, impacted=[], impacted_files=[],
                threshold_used=threshold,
                total_graph_nodes=graph.number_of_nodes(),
                total_graph_edges=graph.number_of_edges(),
            )

        # BFS over reverse edges with confidence decay
        visited: dict[str, ImpactedNode] = {}
        # Queue: (node, confidence, hop, path, edge_kinds)
        queue: list[tuple[str, float, int, list[str], list[str]]] = [
            (symbol, 1.0, 0, [symbol], [])
        ]

        while queue:
            current, conf, hop, path, ekinds = queue.pop(0)
            if hop > self.max_hops:
                continue

            # Get reverse dependents: predecessors in the graph
            # (edges go source->target where source depends on target)
            for pred in graph.predecessors(current):
                if pred == symbol:
                    continue  # skip self-loops

                edge_data = graph.edges[pred, current]
                ek = edge_data.get("kind", "references")
                ew = self.edge_weights.get(ek, 0.5)
                edge_conf = edge_data.get("confidence", 1.0)

                new_conf = conf * ew * edge_conf * self.decay
                if new_conf < threshold:
                    continue

                new_path = path + [pred]
                new_ekinds = ekinds + [ek]

                # Keep the highest-confidence path to each node
                if pred in visited:
                    if visited[pred].confidence >= new_conf:
                        continue

                node_data = graph.nodes.get(pred, {})
                impact = ImpactedNode(
                    qualified_name=pred,
                    kind=node_data.get("kind", "unknown"),
                    file=node_data.get("file", ""),
                    confidence=round(new_conf, 4),
                    hop_distance=hop + 1,
                    path=new_path,
                    edge_kinds=new_ekinds,
                    relation="reverse",
                )
                visited[pred] = impact
                queue.append((pred, new_conf, hop + 1, new_path, new_ekinds))

        # --- Defect-2 fix: SIBLING relation -----------------------------
        # A and B are siblings if both depend on a common bridge node C.
        # Reached by a bounded forward walk from `symbol` to find bridge
        # candidates, then a bounded reverse walk from each low-in-degree
        # bridge to find siblings. See module docstring for full rationale.
        if self.sibling_enabled:
            self._add_sibling_impacts(graph, symbol, threshold, visited)

        # --- Defect-2 fix: FORWARD relation ------------------------------
        # The changed symbol's own transitive dependencies (successors),
        # up to a small bounded hop count.
        if self.forward_enabled:
            self._add_forward_impacts(graph, symbol, threshold, visited)

        impacted = sorted(visited.values(), key=lambda n: -n.confidence)
        files = sorted({n.file for n in impacted if n.file})

        return ImpactReport(
            changed_symbol=symbol,
            impacted=impacted,
            impacted_files=files,
            threshold_used=threshold,
            total_graph_nodes=graph.number_of_nodes(),
            total_graph_edges=graph.number_of_edges(),
        )

    def _edge_step_conf(self, graph: nx.DiGraph, conf: float, edge_source: str, edge_target: str) -> tuple[float, str]:
        """One hop's confidence update, shared by reverse/sibling/forward walks.

        `edge_source`/`edge_target` are the edge exactly as networkx stores
        it (edges always go depender -> dependee, i.e. `graph.edges[source,
        target]` regardless of which logical direction a BFS is walking) --
        callers pass whichever concrete (source, target) pair the hop just
        traversed, so the SAME edge-weight/decay formula applies everywhere
        in the oracle, not a bespoke one per relation type.
        """
        edge_data = graph.edges[edge_source, edge_target]
        ek = edge_data.get("kind", "references")
        ew = self.edge_weights.get(ek, 0.5)
        edge_conf = edge_data.get("confidence", 1.0)
        return conf * ew * edge_conf * self.decay, ek

    def _add_sibling_impacts(self, graph, symbol, threshold, visited: dict[str, ImpactedNode]) -> None:
        """Extend `visited` in place with SIBLING-relation impacts.

        Step 1: bounded forward BFS from `symbol` (up to
        `sibling_forward_hops`) to collect bridge candidates -- nodes
        `symbol` transitively depends on.
        Step 2: for each bridge whose GLOBAL in-degree is <= the cap
        (skip hub modules -- weak sibling evidence, see module docstring),
        a bounded reverse BFS (up to `sibling_reverse_hops`) to collect
        sibling candidates -- other nodes that also depend on the bridge.
        Score = (forward path conf to bridge) * (reverse path conf from
        bridge) * sibling_weight. Terminal: sibling nodes are not
        themselves re-expanded through any relation.
        """
        # Step 1: forward walk to find bridges (dedup by keeping best conf/path per bridge)
        bridges: dict[str, tuple[float, list[str], list[str]]] = {}  # node -> (conf, path, ekinds)
        fqueue: list[tuple[str, float, int, list[str], list[str]]] = [(symbol, 1.0, 0, [symbol], [])]
        fseen = {symbol}
        while fqueue:
            current, conf, hop, path, ekinds = fqueue.pop(0)
            if hop >= self.sibling_forward_hops:
                continue
            for succ in graph.successors(current):
                if succ == symbol:
                    continue
                new_conf, ek = self._edge_step_conf(graph, conf, current, succ)
                new_path = path + [succ]
                new_ekinds = ekinds + [ek]
                if succ not in bridges or bridges[succ][0] < new_conf:
                    bridges[succ] = (new_conf, new_path, new_ekinds)
                if succ not in fseen:
                    fseen.add(succ)
                    fqueue.append((succ, new_conf, hop + 1, new_path, new_ekinds))

        # Step 2: for each low-in-degree bridge, reverse walk to find siblings
        for bridge, (bridge_conf, bridge_path, bridge_ekinds) in bridges.items():
            if graph.in_degree(bridge) > self.sibling_bridge_max_indegree:
                continue  # hub module: weak sibling evidence, skip

            rqueue: list[tuple[str, float, int, list[str], list[str]]] = [(bridge, bridge_conf, 0, bridge_path, bridge_ekinds)]
            rseen = {bridge, symbol}
            while rqueue:
                current, conf, hop, path, ekinds = rqueue.pop(0)
                if hop >= self.sibling_reverse_hops:
                    continue
                for pred in graph.predecessors(current):
                    if pred in rseen or pred == symbol:
                        continue
                    step_conf, ek = self._edge_step_conf(graph, conf, pred, current)
                    final_conf = step_conf * self.sibling_weight
                    new_path = path + [pred]
                    new_ekinds = ekinds + [ek]
                    rseen.add(pred)
                    if final_conf < threshold:
                        continue
                    if pred in visited and visited[pred].confidence >= round(final_conf, 4):
                        continue
                    node_data = graph.nodes.get(pred, {})
                    visited[pred] = ImpactedNode(
                        qualified_name=pred,
                        kind=node_data.get("kind", "unknown"),
                        file=node_data.get("file", ""),
                        confidence=round(final_conf, 4),
                        hop_distance=len(new_path) - 1,
                        path=new_path,
                        edge_kinds=new_ekinds,
                        relation="sibling",
                    )
                    # terminal: do not enqueue `pred` for further sibling expansion
                    if hop + 1 < self.sibling_reverse_hops:
                        rqueue.append((pred, step_conf, hop + 1, new_path, new_ekinds))

    def _add_forward_impacts(self, graph, symbol, threshold, visited: dict[str, ImpactedNode]) -> None:
        """Extend `visited` in place with FORWARD-relation impacts: the
        changed symbol's own transitive dependencies, up to
        `forward_max_hops`. Terminal: forward nodes are not re-expanded
        through the reverse or sibling relations.
        """
        queue: list[tuple[str, float, int, list[str], list[str]]] = [(symbol, 1.0, 0, [symbol], [])]
        seen = {symbol}
        while queue:
            current, conf, hop, path, ekinds = queue.pop(0)
            if hop >= self.forward_max_hops:
                continue
            for succ in graph.successors(current):
                if succ in seen:
                    continue
                step_conf, ek = self._edge_step_conf(graph, conf, current, succ)
                final_conf = step_conf * self.forward_weight
                new_path = path + [succ]
                new_ekinds = ekinds + [ek]
                seen.add(succ)
                if final_conf >= threshold and (succ not in visited or visited[succ].confidence < round(final_conf, 4)):
                    node_data = graph.nodes.get(succ, {})
                    visited[succ] = ImpactedNode(
                        qualified_name=succ,
                        kind=node_data.get("kind", "unknown"),
                        file=node_data.get("file", ""),
                        confidence=round(final_conf, 4),
                        hop_distance=hop + 1,
                        path=new_path,
                        edge_kinds=new_ekinds,
                        relation="forward",
                    )
                queue.append((succ, step_conf, hop + 1, new_path, new_ekinds))

    @staticmethod
    def grep_baseline(symbol_name: str, root: str) -> set[str]:
        """Baseline 1: grep for the bare symbol name across all .py files.

        Returns the set of files (relative paths) containing the name.
        Over-broad on common names (e.g. 'get', 'run').
        """
        import os
        from pathlib import Path

        short_name = symbol_name.split(".")[-1]
        hits: set[str] = set()
        root_path = Path(root)
        for dirpath, dirnames, filenames in os.walk(root_path):
            dirnames[:] = [d for d in dirnames if not d.startswith(".") and d != "__pycache__"]
            for fn in filenames:
                if not fn.endswith(".py"):
                    continue
                fpath = os.path.join(dirpath, fn)
                try:
                    text = Path(fpath).read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
                if short_name in text:
                    hits.add(str(Path(fpath).relative_to(root_path)))
        return hits

    @staticmethod
    def edited_file_baseline(symbol: str, graph: nx.DiGraph) -> set[str]:
        """Baseline 2: only the file containing the edited symbol.

        Under-broad — misses all cross-file dependents.
        """
        if symbol in graph:
            f = graph.nodes[symbol].get("file", "")
            return {f} if f else set()
        return set()
