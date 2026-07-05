"""Persistent structural world-model of a Python codebase.

Builds and maintains a directed graph whose nodes are symbols and whose
edges are structural dependencies.  The graph is persisted to disk as
JSON (node-link format) only — never pickle, which would execute arbitrary
code on load.  On subsequent runs only files whose content hash has changed
are re-parsed (incremental update).
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import networkx as nx

from impact_oracle.parser import (
    ParseResult,
    content_hash,
    discover_python_files,
    parse_file,
)


class WorldModel:
    """A persistent, incrementally-updated structural graph of a codebase.

    Nodes carry SymbolNode metadata; edges carry DependencyEdge metadata.
    The graph is directed: an edge (A -> B) means 'A depends on B'.
    """

    def __init__(self, root: str, cache_dir: str | None = None):
        """
        Parameters
        ----------
        root : str
            Path to the codebase root directory.
        cache_dir : str, optional
            Directory to persist the graph.  Defaults to ``<root>/.impact_oracle_cache``.
        """
        self.root = os.path.abspath(root)
        # Defense-in-depth: a caller-supplied cache_dir must resolve inside root, so a
        # hostile MCP argument cannot point persistence I/O at an arbitrary location.
        if cache_dir is None:
            self.cache_dir = os.path.join(self.root, ".impact_oracle_cache")
        else:
            resolved = os.path.abspath(cache_dir)
            if os.path.commonpath([resolved, self.root]) != self.root:
                raise ValueError(
                    f"cache_dir {cache_dir!r} must be inside root {self.root!r}"
                )
            self.cache_dir = resolved
        self.graph: nx.DiGraph = nx.DiGraph()
        # content-hash cache: filepath (relative) -> hash
        self._file_hashes: dict[str, str] = {}
        # Track which files contributed which nodes
        self._file_nodes: dict[str, list[str]] = {}  # filepath -> [qualified_names]

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def build(self, incremental: bool = True) -> dict[str, Any]:
        """Parse the codebase and (re)build the graph.

        Parameters
        ----------
        incremental : bool
            If True (default), only re-parse files whose content hash
            differs from the cached version.

        Returns
        -------
        dict
            Stats: files_total, files_parsed, files_skipped, nodes, edges.
        """
        if incremental:
            self._load_cache()

        files = discover_python_files(self.root)
        parsed = 0
        skipped = 0

        for fpath in files:
            rel = str(Path(fpath).relative_to(self.root))
            # Read source to check hash
            try:
                source = Path(fpath).read_text(encoding="utf-8", errors="replace")
            except OSError:
                skipped += 1
                continue
            chash = content_hash(source)

            if incremental and self._file_hashes.get(rel) == chash:
                skipped += 1
                continue

            # Remove old nodes/edges from this file
            self._remove_file_contributions(rel)

            result = parse_file(fpath, self.root)
            self._apply_parse_result(result)
            self._file_hashes[rel] = chash
            parsed += 1

        # Remove stale files that no longer exist
        current_rels = {str(Path(f).relative_to(self.root)) for f in files}
        stale = set(self._file_hashes.keys()) - current_rels
        for rel in stale:
            self._remove_file_contributions(rel)
            del self._file_hashes[rel]

        # Resolve cross-module edges
        self._resolve_cross_module_edges()

        self._save_cache()

        return {
            "files_total": len(files),
            "files_parsed": parsed,
            "files_skipped": skipped,
            "nodes": self.graph.number_of_nodes(),
            "edges": self.graph.number_of_edges(),
        }

    def get_node(self, qualified_name: str) -> dict[str, Any] | None:
        """Return metadata for a node, or None if not found."""
        if qualified_name in self.graph:
            return dict(self.graph.nodes[qualified_name])
        return None

    def get_dependencies(self, qualified_name: str) -> list[dict[str, Any]]:
        """Return all symbols that *qualified_name* depends on (outgoing)."""
        if qualified_name not in self.graph:
            return []
        return [
            {"target": t, **self.graph.edges[qualified_name, t]}
            for t in self.graph.successors(qualified_name)
        ]

    def get_dependents(self, qualified_name: str) -> list[dict[str, Any]]:
        """Return all symbols that depend on *qualified_name* (incoming)."""
        if qualified_name not in self.graph:
            return []
        return [
            {"source": s, **self.graph.edges[s, qualified_name]}
            for s in self.graph.predecessors(qualified_name)
        ]

    def all_nodes(self, kind: str | None = None) -> list[dict[str, Any]]:
        """List all nodes, optionally filtered by kind."""
        results = []
        for n, data in self.graph.nodes(data=True):
            if kind and data.get("kind") != kind:
                continue
            results.append({"qualified_name": n, **data})
        return results

    def summary(self) -> dict[str, Any]:
        """Return a summary of the world model."""
        kinds: dict[str, int] = {}
        for _, data in self.graph.nodes(data=True):
            k = data.get("kind", "unknown")
            kinds[k] = kinds.get(k, 0) + 1
        edge_kinds: dict[str, int] = {}
        for _, _, data in self.graph.edges(data=True):
            k = data.get("kind", "unknown")
            edge_kinds[k] = edge_kinds.get(k, 0) + 1
        return {
            "nodes": self.graph.number_of_nodes(),
            "edges": self.graph.number_of_edges(),
            "node_kinds": kinds,
            "edge_kinds": edge_kinds,
            "files": len(self._file_hashes),
        }

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def _save_cache(self):
        os.makedirs(self.cache_dir, exist_ok=True)
        # JSON node-link is the ONLY persistence format. Pickle was removed: loading a
        # pickle executes arbitrary code, and cache_dir can be caller-supplied, which made
        # graph.pkl an insecure-deserialization (RCE) vector. JSON is data-only and safe.
        data = nx.node_link_data(self.graph)
        with open(os.path.join(self.cache_dir, "graph.json"), "w") as f:
            json.dump(data, f, indent=1)
        with open(os.path.join(self.cache_dir, "file_hashes.json"), "w") as f:
            json.dump(self._file_hashes, f)
        with open(os.path.join(self.cache_dir, "file_nodes.json"), "w") as f:
            json.dump(self._file_nodes, f)

    def _load_cache(self):
        json_path = os.path.join(self.cache_dir, "graph.json")
        hash_path = os.path.join(self.cache_dir, "file_hashes.json")
        fn_path = os.path.join(self.cache_dir, "file_nodes.json")

        if os.path.exists(json_path):
            try:
                with open(json_path) as f:
                    self.graph = nx.node_link_graph(json.load(f))
            except Exception:
                self.graph = nx.DiGraph()

        if os.path.exists(hash_path):
            with open(hash_path) as f:
                self._file_hashes = json.load(f)

        if os.path.exists(fn_path):
            with open(fn_path) as f:
                self._file_nodes = json.load(f)

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _apply_parse_result(self, result: ParseResult):
        """Add nodes and edges from a parse result to the graph."""
        node_names: list[str] = []
        for sn in result.nodes:
            self.graph.add_node(sn.qualified_name, **sn.to_dict())
            node_names.append(sn.qualified_name)

        for edge in result.edges:
            self.graph.add_edge(
                edge.source,
                edge.target,
                kind=edge.kind,
                confidence=edge.confidence,
                lineno=edge.lineno,
            )

        self._file_nodes[result.file] = node_names

    def _remove_file_contributions(self, rel_path: str):
        """Remove all nodes and their edges that came from a file."""
        names = self._file_nodes.pop(rel_path, [])
        for n in names:
            if n in self.graph:
                self.graph.remove_node(n)  # also removes incident edges

    def _resolve_cross_module_edges(self):
        """Best-effort resolution of import targets to known graph nodes.

        When an import edge points at 'pkg.mod.func' and we have that
        node in the graph, the edge target is already correct.  When the
        target is a module but the actual use is 'mod.func', we try to
        find the function inside the module.
        """
        existing = set(self.graph.nodes)
        edges_to_add: list[tuple[str, str, dict]] = []
        edges_to_remove: list[tuple[str, str]] = []

        for u, v, data in list(self.graph.edges(data=True)):
            if v in existing:
                continue
            # Try parent.v as a resolution
            # e.g. target 'utils.helper_func' might live as 'demo_package.utils.helper_func'
            candidates = [
                n
                for n in existing
                if n.endswith(f".{v}") or n.endswith(f".{v.split('.')[-1]}")
            ]
            if len(candidates) == 1:
                edges_to_remove.append((u, v))
                edges_to_add.append(
                    (
                        u,
                        candidates[0],
                        {**data, "confidence": data.get("confidence", 1.0) * 0.9},
                    )
                )
            elif len(candidates) > 1:
                # ambiguous: pick the best match (longest common suffix)
                best = max(
                    candidates,
                    key=lambda c: len(os.path.commonprefix([c[::-1], v[::-1]])),
                )
                edges_to_remove.append((u, v))
                edges_to_add.append(
                    (u, best, {**data, "confidence": data.get("confidence", 1.0) * 0.7})
                )

        for u, v in edges_to_remove:
            if self.graph.has_edge(u, v):
                self.graph.remove_edge(u, v)
        for u, v, d in edges_to_add:
            self.graph.add_edge(u, v, **d)

        # Merge phantom nodes: when an import creates a node like
        # 'pkg.mod.func' but the parser already has 'mod.func' (because
        # root=pkg), redirect all edges to the real node and remove the phantom.
        self._merge_phantom_nodes()

    def _merge_phantom_nodes(self):
        """Merge nodes whose qualified_name is a suffix of another existing node.

        Import targets like 'demo_package.utils.validation.validate_positive'
        are phantom duplicates of parsed nodes like 'utils.validation.validate_positive'
        when the codebase root IS 'demo_package/'.  We redirect all edges
        from the phantom to the real node.
        """
        # "Real" nodes are those explicitly added by the parser with metadata
        real_nodes = {n for n, d in self.graph.nodes(data=True) if d.get("kind")}
        all_nodes = set(self.graph.nodes)
        phantoms_to_merge: dict[str, str] = {}  # phantom -> real

        for n in all_nodes:
            if n in real_nodes:
                continue
            # Check if this is a prefixed version of a real node
            # e.g. 'demo_package.utils.validation.validate_positive' -> 'utils.validation.validate_positive'
            parts = n.split(".")
            for i in range(1, len(parts)):
                suffix = ".".join(parts[i:])
                if suffix in real_nodes:
                    phantoms_to_merge[n] = suffix
                    break

        for phantom, real in phantoms_to_merge.items():
            # Transfer all incoming edges to the real node
            for pred in list(self.graph.predecessors(phantom)):
                if pred == real:
                    continue
                edge_data = dict(self.graph.edges[pred, phantom])
                if not self.graph.has_edge(pred, real):
                    self.graph.add_edge(pred, real, **edge_data)
                else:
                    # Keep the higher-confidence edge
                    existing = self.graph.edges[pred, real]
                    if edge_data.get("confidence", 0) > existing.get("confidence", 0):
                        self.graph.edges[pred, real].update(edge_data)

            # Transfer all outgoing edges from the phantom
            for succ in list(self.graph.successors(phantom)):
                if succ == real:
                    continue
                edge_data = dict(self.graph.edges[phantom, succ])
                if not self.graph.has_edge(real, succ):
                    self.graph.add_edge(real, succ, **edge_data)

            # Remove the phantom
            self.graph.remove_node(phantom)
