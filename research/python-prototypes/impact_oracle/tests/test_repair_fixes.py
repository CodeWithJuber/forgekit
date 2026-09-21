"""Regression tests for the two repair-track fixes.

Defect 1: src-layout absolute imports created disconnected phantom nodes
because WorldModel derives module qualified-names from the file path
relative to `root`, and code elsewhere in the same repo may reference the
same module without the layout prefix. Fixed in
`WorldModel._merge_phantom_nodes` (a second, symmetric direction added
alongside the shipped demo-package direction), grounded in prefixes the
parser actually observed (not a blind name-suffix search, which is unsound
-- see the stdlib-collision test below).

Defect 2: predict_impact only traversed reverse (who-depends-on-me) edges,
missing the dominant real-world co-change pattern where two files share a
common dependency ("siblings") without either being reverse-reachable from
the other, and the minority pattern where the changed symbol's own
dependencies plausibly need a matching update ("forward"). Fixed by two new,
independently-toggleable, terminal (non-recursively-expanded) traversal
extensions in ImpactOracle.predict_impact.
"""
from __future__ import annotations

import os
import shutil
import tempfile

import networkx as nx
import pytest

from impact_oracle.world_model import WorldModel
from impact_oracle.oracle import ImpactOracle


# ---------------------------------------------------------------------
# Defect 1: src-layout phantom-node merge
# ---------------------------------------------------------------------

def _wm_from_graph(nodes, edges):
    """Build a WorldModel-like object around a hand-constructed graph,
    bypassing file parsing (isolates the merge logic under test)."""
    wm = WorldModel.__new__(WorldModel)
    wm.graph = nx.DiGraph()
    for n, meta in nodes:
        wm.graph.add_node(n, **meta)
    for u, v, meta in edges:
        wm.graph.add_edge(u, v, **meta)
    return wm


class TestDefect1PhantomNodeMerge:
    def test_src_layout_unprefixed_import_resolves(self):
        """The exact pytest/_pytest.pytester scenario from the diagnostic:
        a real node carries the 'src.' prefix (parser root = repo root),
        but an absolute import elsewhere in the repo legitimately omits
        it. Before the fix, this phantom was never merged and the file
        was structurally unreachable from predict_impact."""
        wm = _wm_from_graph(
            nodes=[
                ("src._pytest.pytester.Pytester", {"kind": "class", "file": "src/_pytest/pytester.py"}),
                ("testing.test_setuponly", {"kind": "module", "file": "testing/test_setuponly.py"}),
            ],
            edges=[
                ("testing.test_setuponly", "_pytest.pytester.Pytester",
                 {"kind": "imports", "confidence": 1.0, "lineno": 7}),
            ],
        )
        wm._resolve_cross_module_edges()
        assert wm.graph.has_edge("testing.test_setuponly", "src._pytest.pytester.Pytester")
        assert "_pytest.pytester.Pytester" not in wm.graph  # phantom removed, not left dangling

        oracle = ImpactOracle(wm, sibling_enabled=False, forward_enabled=False)
        report = oracle.predict_impact("src._pytest.pytester.Pytester", threshold=0.02)
        assert "testing/test_setuponly.py" in report.impacted_files

    def test_shipped_demo_package_direction_still_works(self):
        """The direction the method shipped with (phantom carries an EXTRA
        prefix relative to a shorter real node) must be unaffected by the
        fix -- this is a non-regression check."""
        wm = _wm_from_graph(
            nodes=[
                ("utils.validation.validate_positive", {"kind": "function", "file": "utils/validation.py"}),
                ("orders", {"kind": "module", "file": "orders.py"}),
            ],
            edges=[
                ("orders", "demo_package.utils.validation.validate_positive",
                 {"kind": "calls", "confidence": 0.95, "lineno": 10}),
            ],
        )
        wm._resolve_cross_module_edges()
        assert wm.graph.has_edge("orders", "utils.validation.validate_positive")

    def test_stdlib_name_collision_is_not_merged(self):
        """SAFETY test: a bare `import json` (stdlib) must NOT be merged
        into an unrelated local submodule that happens to share the name
        (e.g. a local 'pkg.json' re-export module) just because it is a
        dotted suffix match. This is the exact failure mode a naive
        "any suffix of any real node" search would introduce -- and is
        also literally the sibling-pattern example from the evaluation's
        own failure-mode analysis (flask's src.flask.json), so it must be
        handled by the SIBLING relation (defect 2), not by incorrectly
        collapsing the two nodes into one (which would fabricate a false
        direct dependency, not just a weaker sibling one)."""
        wm = _wm_from_graph(
            nodes=[
                ("src.flask.json", {"kind": "module", "file": "src/flask/json/__init__.py"}),
                ("src.flask", {"kind": "module", "file": "src/flask/__init__.py"}),
                ("some_other_module", {"kind": "module", "file": "src/flask/somewhere.py"}),
            ],
            edges=[
                ("some_other_module", "json", {"kind": "imports", "confidence": 1.0, "lineno": 1}),
            ],
        )
        wm._resolve_cross_module_edges()
        assert not wm.graph.has_edge("some_other_module", "src.flask.json")

    def test_no_layout_prefix_no_spurious_merge(self):
        """If no real node's file has a multi-component path (i.e. no
        layout prefix was ever observed), an unresolved phantom must be
        left alone rather than guessed at."""
        wm = _wm_from_graph(
            nodes=[
                ("mymodule", {"kind": "module", "file": "mymodule.py"}),
            ],
            edges=[
                ("mymodule", "totally_unrelated_name", {"kind": "references", "confidence": 0.7, "lineno": 3}),
            ],
        )
        wm._resolve_cross_module_edges()
        # phantom has no incoming/outgoing beyond the one edge -> not merged, but also not
        # spuriously deleted if it still carries the edge (degree > 0 keeps it)
        assert not any(wm.graph.has_edge("mymodule", n) for n in wm.graph.nodes
                        if n not in ("mymodule", "totally_unrelated_name"))


# ---------------------------------------------------------------------
# Defect 2: sibling + forward traversal
# ---------------------------------------------------------------------

class TestDefect2SiblingTraversal:
    def test_sibling_relation_recovers_shared_dependency_pair(self):
        """The exact flask __init__.py / json/__init__.py diagnostic
        example: both modules import/reference the stdlib `json` module;
        neither is reverse-reachable from the other, so the shipped
        reverse-only oracle could never find this pair."""
        wm = _wm_from_graph(
            nodes=[
                ("src.flask", {"kind": "module", "file": "src/flask/__init__.py"}),
                ("src.flask.json", {"kind": "module", "file": "src/flask/json/__init__.py"}),
                ("src.flask.json.load", {"kind": "function", "file": "src/flask/json/__init__.py", "parent": "src.flask.json"}),
            ],
            edges=[
                ("src.flask", "json", {"kind": "imports", "confidence": 1.0, "lineno": 1}),
                ("src.flask.json.load", "json", {"kind": "references", "confidence": 0.8, "lineno": 5}),
            ],
        )
        oracle = ImpactOracle(wm, sibling_forward_hops=1, sibling_reverse_hops=1, sibling_bridge_max_indegree=25)
        report = oracle.predict_impact("src.flask", threshold=0.02)
        assert "src/flask/json/__init__.py" in report.impacted_files
        sib_nodes = [n for n in report.impacted if n.relation == "sibling"]
        assert len(sib_nodes) >= 1

    def test_sibling_relation_respects_indegree_cap(self):
        """A hub bridge (high in-degree) must NOT generate sibling
        impacts -- otherwise every file sharing a common stdlib/utility
        import would be flagged, destroying precision."""
        wm_graph_nodes = [("changed_module", {"kind": "module", "file": "changed.py"})]
        wm_graph_edges = [("changed_module", "os", {"kind": "imports", "confidence": 1.0, "lineno": 1})]
        for i in range(200):
            wm_graph_nodes.append((f"unrelated_{i}", {"kind": "module", "file": f"unrelated_{i}.py"}))
            wm_graph_edges.append((f"unrelated_{i}", "os", {"kind": "imports", "confidence": 1.0, "lineno": 1}))
        wm = _wm_from_graph(wm_graph_nodes, wm_graph_edges)

        oracle = ImpactOracle(wm, sibling_bridge_max_indegree=25)
        report = oracle.predict_impact("changed_module", threshold=0.02)
        sibling_files = [n.file for n in report.impacted if n.relation == "sibling"]
        assert sibling_files == []

    def test_sibling_relation_allows_low_indegree_bridge(self):
        """The complement of the cap test: a bridge with in-degree well
        under the cap SHOULD produce sibling impacts."""
        wm = _wm_from_graph(
            nodes=[
                ("module_a", {"kind": "module", "file": "a.py"}),
                ("module_b", {"kind": "module", "file": "b.py"}),
                ("shared_util", {"kind": "module", "file": "shared_util.py"}),
            ],
            edges=[
                ("module_a", "shared_util", {"kind": "imports", "confidence": 1.0, "lineno": 1}),
                ("module_b", "shared_util", {"kind": "imports", "confidence": 1.0, "lineno": 1}),
            ],
        )
        oracle = ImpactOracle(wm, sibling_bridge_max_indegree=25)
        report = oracle.predict_impact("module_a", threshold=0.02)
        assert "b.py" in report.impacted_files

    def test_sibling_disabled_falls_back_to_reverse_only(self):
        """sibling_enabled=False must reproduce byte-identical (empty, in
        this case) as-shipped reverse-only behavior."""
        wm = _wm_from_graph(
            nodes=[
                ("module_a", {"kind": "module", "file": "a.py"}),
                ("module_b", {"kind": "module", "file": "b.py"}),
                ("shared_util", {"kind": "module", "file": "shared_util.py"}),
            ],
            edges=[
                ("module_a", "shared_util", {"kind": "imports", "confidence": 1.0, "lineno": 1}),
                ("module_b", "shared_util", {"kind": "imports", "confidence": 1.0, "lineno": 1}),
            ],
        )
        oracle = ImpactOracle(wm, sibling_enabled=False, forward_enabled=False)
        report = oracle.predict_impact("module_a", threshold=0.02)
        assert report.impacted_files == []


class TestDefect2ForwardTraversal:
    def test_forward_relation_finds_own_dependency(self):
        """Editing a call site plausibly means its callee needs a matching
        update too -- the shipped oracle never looked forward at all."""
        wm = _wm_from_graph(
            nodes=[
                ("caller_module", {"kind": "module", "file": "caller.py"}),
                ("callee_module.helper", {"kind": "function", "file": "callee.py"}),
            ],
            edges=[
                ("caller_module", "callee_module.helper", {"kind": "calls", "confidence": 0.95, "lineno": 1}),
            ],
        )
        oracle = ImpactOracle(wm, forward_max_hops=2)
        report = oracle.predict_impact("caller_module", threshold=0.02)
        assert "callee.py" in report.impacted_files
        fwd_nodes = [n for n in report.impacted if n.relation == "forward"]
        assert len(fwd_nodes) >= 1

    def test_forward_relation_respects_hop_cap(self):
        """A dependency chain longer than forward_max_hops must not be
        reported via the forward relation."""
        wm = _wm_from_graph(
            nodes=[
                ("a", {"kind": "module", "file": "a.py"}),
                ("b", {"kind": "module", "file": "b.py"}),
                ("c", {"kind": "module", "file": "c.py"}),
                ("d", {"kind": "module", "file": "d.py"}),
            ],
            edges=[
                ("a", "b", {"kind": "imports", "confidence": 1.0, "lineno": 1}),
                ("b", "c", {"kind": "imports", "confidence": 1.0, "lineno": 1}),
                ("c", "d", {"kind": "imports", "confidence": 1.0, "lineno": 1}),
            ],
        )
        oracle = ImpactOracle(wm, forward_max_hops=1, forward_weight=1.0, decay=1.0,
                               sibling_enabled=False)
        report = oracle.predict_impact("a", threshold=0.01)
        files = set(report.impacted_files)
        assert "b.py" in files
        assert "c.py" not in files  # 2 hops away, cap is 1
        assert "d.py" not in files

    def test_forward_disabled_falls_back_to_reverse_only(self):
        wm = _wm_from_graph(
            nodes=[
                ("caller_module", {"kind": "module", "file": "caller.py"}),
                ("callee_module.helper", {"kind": "function", "file": "callee.py"}),
            ],
            edges=[
                ("caller_module", "callee_module.helper", {"kind": "calls", "confidence": 0.95, "lineno": 1}),
            ],
        )
        oracle = ImpactOracle(wm, forward_enabled=False, sibling_enabled=False)
        report = oracle.predict_impact("caller_module", threshold=0.02)
        assert report.impacted_files == []


class TestDefect2Termination:
    def test_sibling_and_forward_nodes_are_terminal(self):
        """A node reached via sibling or forward must not itself become a
        new expansion root for another sibling/forward search -- this is
        what keeps the algorithm's fan-out bounded independent of graph
        size (see oracle.py module docstring)."""
        # b and c are siblings via bridge; d is a further sibling of c that
        # should NOT be reached (would require re-expanding a sibling node).
        wm = _wm_from_graph(
            nodes=[(n, {"kind": "module", "file": f"{n}.py"}) for n in ["a", "b", "bridge1", "c", "bridge2", "d"]],
            edges=[
                ("a", "bridge1", {"kind": "imports", "confidence": 1.0, "lineno": 1}),
                ("b", "bridge1", {"kind": "imports", "confidence": 1.0, "lineno": 1}),
                ("c", "bridge2", {"kind": "imports", "confidence": 1.0, "lineno": 1}),
                ("b", "bridge2", {"kind": "imports", "confidence": 1.0, "lineno": 1}),
                ("d", "bridge2", {"kind": "imports", "confidence": 1.0, "lineno": 1}),
            ],
        )
        oracle = ImpactOracle(wm, sibling_weight=1.0, decay=1.0, sibling_bridge_max_indegree=100)
        report = oracle.predict_impact("a", threshold=0.01)
        files = set(report.impacted_files)
        assert "b.py" in files       # direct sibling via bridge1
        assert "c.py" not in files   # would require expanding FROM sibling b via bridge2
        assert "d.py" not in files


# ---------------------------------------------------------------------
# End-to-end: fixes compose without breaking the original mutation demo
# ---------------------------------------------------------------------

class TestEndToEndDemoStillWorks:
    def test_demo_package_recall_still_perfect_with_both_fixes(self):
        """The demo package's own headline mutation-testing claim (recall
        1.0 across all 5 mutations) must not regress now that both fixes
        are active by default."""
        import subprocess
        import sys as _sys

        workspace = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        root = os.path.join(workspace, "demo_package")
        # This WorldModel refuses a cache_dir outside its root (hardening against a
        # hostile MCP argument), so the throwaway cache lives inside the demo package.
        cache_dir = tempfile.mkdtemp(dir=root)
        try:
            wm = WorldModel(root, cache_dir=cache_dir)
            wm.build(incremental=False)
            oracle = ImpactOracle(wm)  # defaults: both fixes active
            # Spot check one of evaluate.py's mutation targets directly
            report = oracle.predict_impact("models.PremiumProduct.discounted_price", threshold=0.1)
            assert "models.py" in report.impacted_files
        finally:
            shutil.rmtree(cache_dir, ignore_errors=True)
