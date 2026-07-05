"""Impact Oracle: blast-radius prediction for symbol changes.

Given a world-model graph and a proposed change to symbol X, the oracle
traverses *reverse* dependency edges (who imports/calls/inherits/references X)
to predict the set of symbols and files that would be affected.  Each
impacted node carries a decaying confidence score and the dependency path
that connects it to X.
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
    """

    def __init__(
        self,
        world_model: WorldModel,
        decay: float = DEFAULT_DECAY,
        edge_weights: dict[str, float] | None = None,
        max_hops: int = 10,
    ):
        self.wm = world_model
        self.decay = decay
        self.edge_weights = edge_weights or EDGE_WEIGHTS
        self.max_hops = max_hops

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
                )
                visited[pred] = impact
                queue.append((pred, new_conf, hop + 1, new_path, new_ekinds))

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
