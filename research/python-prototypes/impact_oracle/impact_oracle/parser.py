"""AST-based Python source parser.

Extracts structural symbols (modules, classes, functions, names) and
dependency edges (imports, calls, inherits, references, contains) from
Python source files.  Designed for incremental re-parsing: each file is
content-hashed so unchanged files are skipped on subsequent runs.
"""

from __future__ import annotations

import ast
import hashlib
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Data containers
# ---------------------------------------------------------------------------

@dataclass
class SymbolNode:
    """A symbol extracted from source: module, class, function, or name."""
    qualified_name: str          # e.g. 'pkg.mod.Class.method'
    kind: str                    # 'module' | 'class' | 'function' | 'name'
    file: str                    # relative path inside the codebase root
    lineno: int = 0
    end_lineno: int | None = None
    signature: str = ""          # for functions/methods
    docstring: str = ""
    parent: str = ""             # qualified_name of enclosing scope

    def to_dict(self) -> dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v or k == "lineno"}

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "SymbolNode":
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


@dataclass
class DependencyEdge:
    """A directed dependency from *source* to *target*."""
    source: str        # qualified_name of the depending symbol
    target: str        # qualified_name of the depended-upon symbol
    kind: str          # 'imports' | 'calls' | 'inherits' | 'references' | 'contains'
    confidence: float = 1.0   # 1.0 = certain; <1 = heuristic inference
    lineno: int = 0

    def to_dict(self) -> dict[str, Any]:
        return self.__dict__.copy()

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "DependencyEdge":
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


@dataclass
class ParseResult:
    """All symbols and edges extracted from one file."""
    file: str
    content_hash: str
    nodes: list[SymbolNode] = field(default_factory=list)
    edges: list[DependencyEdge] = field(default_factory=list)


# ---------------------------------------------------------------------------
# AST visitor
# ---------------------------------------------------------------------------

class _SymbolVisitor(ast.NodeVisitor):
    """Walk an AST, accumulating SymbolNodes and DependencyEdges."""

    def __init__(self, module_qname: str, filepath: str):
        self.module_qname = module_qname
        self.filepath = filepath
        self.nodes: list[SymbolNode] = []
        self.edges: list[DependencyEdge] = []
        # Stack of (qualified_name, kind) for scope tracking
        self._scope_stack: list[tuple[str, str]] = [(module_qname, "module")]
        # Track import aliases:  alias -> qualified_name
        self._import_map: dict[str, str] = {}

    # -- helpers --

    @property
    def _current_scope(self) -> str:
        return self._scope_stack[-1][0]

    def _qname(self, name: str) -> str:
        return f"{self._current_scope}.{name}"

    @staticmethod
    def _signature_of(node: ast.FunctionDef | ast.AsyncFunctionDef) -> str:
        """Build a human-readable signature string."""
        args = node.args
        parts: list[str] = []
        # positional
        all_args = args.args
        defaults_offset = len(all_args) - len(args.defaults)
        for i, a in enumerate(all_args):
            ann = ""
            if a.annotation:
                try:
                    ann = ": " + ast.unparse(a.annotation)
                except Exception:
                    pass
            default = ""
            di = i - defaults_offset
            if di >= 0:
                try:
                    default = "=" + ast.unparse(args.defaults[di])
                except Exception:
                    pass
            parts.append(f"{a.arg}{ann}{default}")
        if args.vararg:
            parts.append(f"*{args.vararg.arg}")
        for i, a in enumerate(args.kwonlyargs):
            ann = ""
            if a.annotation:
                try:
                    ann = ": " + ast.unparse(a.annotation)
                except Exception:
                    pass
            default = ""
            if args.kw_defaults[i]:
                try:
                    default = "=" + ast.unparse(args.kw_defaults[i])
                except Exception:
                    pass
            parts.append(f"{a.arg}{ann}{default}")
        if args.kwarg:
            parts.append(f"**{args.kwarg.arg}")

        ret = ""
        if node.returns:
            try:
                ret = " -> " + ast.unparse(node.returns)
            except Exception:
                pass
        return f"({', '.join(parts)}){ret}"

    @staticmethod
    def _docstring_of(node: ast.AST) -> str:
        """Extract the leading docstring, if any."""
        if (isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Module))
                and node.body
                and isinstance(node.body[0], ast.Expr)
                and isinstance(node.body[0].value, (ast.Constant,))):
            v = node.body[0].value.value
            if isinstance(v, str):
                first_line = v.strip().split("\n")[0]
                return first_line[:200]
        return ""

    # -- visitors --

    def visit_ClassDef(self, node: ast.ClassDef):
        qn = self._qname(node.name)
        self.nodes.append(SymbolNode(
            qualified_name=qn, kind="class", file=self.filepath,
            lineno=node.lineno, end_lineno=node.end_lineno,
            docstring=self._docstring_of(node), parent=self._current_scope,
        ))
        self.edges.append(DependencyEdge(
            source=self._current_scope, target=qn, kind="contains", lineno=node.lineno,
        ))
        # inheritance edges
        for base in node.bases:
            base_name = self._resolve_name(base)
            if base_name:
                self.edges.append(DependencyEdge(
                    source=qn, target=base_name, kind="inherits",
                    lineno=node.lineno, confidence=0.9,
                ))
        self._scope_stack.append((qn, "class"))
        self.generic_visit(node)
        self._scope_stack.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef):
        self._handle_funcdef(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef):
        self._handle_funcdef(node)

    def _handle_funcdef(self, node):
        qn = self._qname(node.name)
        self.nodes.append(SymbolNode(
            qualified_name=qn, kind="function", file=self.filepath,
            lineno=node.lineno, end_lineno=node.end_lineno,
            signature=self._signature_of(node),
            docstring=self._docstring_of(node), parent=self._current_scope,
        ))
        self.edges.append(DependencyEdge(
            source=self._current_scope, target=qn, kind="contains", lineno=node.lineno,
        ))
        self._scope_stack.append((qn, "function"))
        self.generic_visit(node)
        self._scope_stack.pop()

    def visit_Import(self, node: ast.Import):
        for alias in node.names:
            local = alias.asname or alias.name
            self._import_map[local] = alias.name
            self.edges.append(DependencyEdge(
                source=self._current_scope, target=alias.name, kind="imports",
                lineno=node.lineno,
            ))

    def visit_ImportFrom(self, node: ast.ImportFrom):
        module = node.module or ""
        for alias in (node.names or []):
            target_qname = f"{module}.{alias.name}" if module else alias.name
            local = alias.asname or alias.name
            self._import_map[local] = target_qname
            self.edges.append(DependencyEdge(
                source=self._current_scope, target=target_qname, kind="imports",
                lineno=node.lineno,
            ))

    def visit_Call(self, node: ast.Call):
        callee = self._resolve_name(node.func)
        if callee:
            self.edges.append(DependencyEdge(
                source=self._current_scope, target=callee, kind="calls",
                lineno=getattr(node, "lineno", 0),
                confidence=0.85 if "." in callee else 0.95,
            ))
        self.generic_visit(node)

    def visit_Attribute(self, node: ast.Attribute):
        """Capture attribute references like obj.attr as 'references' edges."""
        full = self._resolve_name(node)
        if full and full != node.attr:
            # Only record if we resolved something meaningful
            # Skip if we're inside a Call (that's handled by visit_Call)
            self.edges.append(DependencyEdge(
                source=self._current_scope, target=full, kind="references",
                lineno=getattr(node, "lineno", 0), confidence=0.7,
            ))
        self.generic_visit(node)

    def visit_Name(self, node: ast.Name):
        """Capture bare-name references to imported symbols."""
        if node.id in self._import_map:
            self.edges.append(DependencyEdge(
                source=self._current_scope, target=self._import_map[node.id],
                kind="references", lineno=node.lineno, confidence=0.8,
            ))
        self.generic_visit(node)

    def visit_Assign(self, node: ast.Assign):
        """Record module-level name assignments."""
        if self._scope_stack[-1][1] == "module":
            for target in node.targets:
                if isinstance(target, ast.Name):
                    qn = self._qname(target.id)
                    self.nodes.append(SymbolNode(
                        qualified_name=qn, kind="name", file=self.filepath,
                        lineno=node.lineno, parent=self._current_scope,
                    ))
                    self.edges.append(DependencyEdge(
                        source=self._current_scope, target=qn, kind="contains",
                        lineno=node.lineno,
                    ))
        self.generic_visit(node)

    # -- name resolution --

    def _resolve_name(self, node: ast.AST) -> str | None:
        """Best-effort resolution of an AST expression to a qualified name."""
        if isinstance(node, ast.Name):
            return self._import_map.get(node.id, self._qname(node.id))
        if isinstance(node, ast.Attribute):
            prefix = self._resolve_name(node.value)
            if prefix:
                return f"{prefix}.{node.attr}"
        return None


# ---------------------------------------------------------------------------
# File-level parser
# ---------------------------------------------------------------------------

def content_hash(source: str) -> str:
    """SHA-256 of the source text, used for incremental caching."""
    return hashlib.sha256(source.encode("utf-8")).hexdigest()[:16]


def parse_file(filepath: str, root: str) -> ParseResult:
    """Parse a single Python file and return extracted symbols + edges.

    Parameters
    ----------
    filepath : str
        Absolute or relative path to the .py file.
    root : str
        The codebase root directory.  Used to derive the module's
        qualified name from its path.
    """
    path = Path(filepath)
    root_path = Path(root)
    try:
        source = path.read_text(encoding="utf-8", errors="replace")
    except (OSError, UnicodeDecodeError) as exc:
        return ParseResult(file=str(path.relative_to(root_path)), content_hash="", nodes=[], edges=[])

    chash = content_hash(source)
    rel = path.relative_to(root_path)
    # Derive module qualified name from path
    parts = list(rel.with_suffix("").parts)
    if parts[-1] == "__init__":
        parts = parts[:-1]
    module_qname = ".".join(parts) if parts else rel.stem

    relpath = str(rel)

    try:
        tree = ast.parse(source, filename=str(filepath))
    except SyntaxError:
        return ParseResult(file=relpath, content_hash=chash, nodes=[], edges=[])

    # Module-level node
    mod_node = SymbolNode(
        qualified_name=module_qname, kind="module", file=relpath,
        lineno=1, docstring=_SymbolVisitor._docstring_of(tree),
    )

    visitor = _SymbolVisitor(module_qname, relpath)
    visitor.visit(tree)

    nodes = [mod_node] + visitor.nodes
    edges = visitor.edges
    return ParseResult(file=relpath, content_hash=chash, nodes=nodes, edges=edges)


def discover_python_files(root: str) -> list[str]:
    """Find all .py files under *root*, excluding hidden/venv dirs."""
    result: list[str] = []
    root_path = Path(root)
    exclude_prefixes = {".", "__pycache__", "venv", ".venv", "node_modules", ".git"}
    for dirpath, dirnames, filenames in os.walk(root_path):
        # Prune excluded directories
        dirnames[:] = [d for d in dirnames if d not in exclude_prefixes and not d.startswith(".")]
        for fn in filenames:
            if fn.endswith(".py"):
                result.append(os.path.join(dirpath, fn))
    return sorted(result)
