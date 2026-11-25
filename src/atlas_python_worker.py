"""Extract syntactic evidence without importing or compiling the indexed project."""
import ast
import json
import sys

# POSIX adds an address-space ceiling to the cross-platform byte, output and time limits.
try:
    import resource
    soft, hard = resource.getrlimit(resource.RLIMIT_AS)
    limits = [256 * 1024 * 1024] + [n for n in (soft, hard) if n != resource.RLIM_INFINITY]
    resource.setrlimit(resource.RLIMIT_AS, (min(limits), hard))
except (ImportError, AttributeError, OSError, ValueError):
    pass


def parse(row):
    root = ast.parse(row["text"], filename=row["file"])
    defs, refs, limitations = [], [], set()
    pending = [(root, -1)]
    visited = 0
    while pending:
        node, owner = pending.pop()
        visited += 1
        if visited > 150000 or len(defs) + len(refs) > 20000:
            return {"reason": "syntax-limit"}
        if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            parent, owner = owner, len(defs)
            defs.append(dict(name=node.name, kind="class" if isinstance(node, ast.ClassDef) else "function",
                             parent=parent, line=node.lineno, endLine=node.end_lineno))

        def ref(kind, target, **rest):
            refs.append(dict(kind=kind, target=target, owner=owner, line=node.lineno, **rest))

        if isinstance(node, ast.Import):
            for alias in node.names:
                ref("imports", alias.name, lang="py", module=alias.name, level=0, names=[])
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            ref("imports", "." * node.level + module, lang="py", module=module, level=node.level,
                names=[dict(imported=a.name, local=a.asname or a.name) for a in node.names])
        elif isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name) and node.func.id == "__import__":
                limitations.add("computed-import")
            elif isinstance(node.func, ast.Name):
                ref("calls", node.func.id)
            else:
                limitations.add("dynamic-dispatch")
                if isinstance(node.func, ast.Attribute) and node.func.attr == "import_module":
                    limitations.add("computed-import")
        elif isinstance(node, ast.ClassDef):
            for base in node.bases:
                if isinstance(base, ast.Name):
                    ref("inherits", base.id)
                else:
                    limitations.add("dynamic-base")
        pending.extend((child, owner) for child in reversed(list(ast.iter_child_nodes(node))))
    return dict(defs=defs, refs=refs, limitations=sorted(limitations))


def analyze(row):
    try:
        return parse(row)
    except (SyntaxError, ValueError):
        return {"reason": "syntax-error"}
    except (MemoryError, RecursionError):
        return {"reason": "syntax-limit"}


json.dump([analyze(row) for row in json.load(sys.stdin)], sys.stdout, separators=(",", ":"))
