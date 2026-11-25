// Isolated syntax worker. Parse supplied text without loading project config or executing it.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const ts = createRequire(import.meta.url)(process.argv[2]);

function parse({ file, text }) {
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  if (tree.parseDiagnostics.length) return { reason: "syntax-error" };
  const defs = [],
    refs = [],
    limitations = new Set();
  const line = (pos) => tree.getLineAndCharacterOfPosition(pos).line + 1;
  let visited = 0;
  function visit(n, parent) {
    if (++visited > 150000 || defs.length + refs.length > 20000) throw new Error("syntax-limit");
    const name = n.name && ts.isIdentifier(n.name) ? n.name.text : null;
    let owner = parent;
    let kind;
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isGetAccessor(n) ||
      ts.isSetAccessor(n)
    )
      kind = "function";
    else if (ts.isClassDeclaration(n)) kind = "class";
    else if (
      ts.isInterfaceDeclaration(n) ||
      ts.isTypeAliasDeclaration(n) ||
      ts.isEnumDeclaration(n)
    )
      kind = "type";
    else if (ts.isVariableDeclaration(n)) kind = "const";
    if (name && kind) {
      owner = defs.length;
      defs.push({
        name,
        kind,
        parent,
        line: line(n.name.getStart(tree)),
        endLine: line(n.end - 1),
      });
    } else if (kind) limitations.add("unnamed-or-pattern-declaration");
    function reference(fields) {
      refs.push({ owner, line: line(n.getStart(tree)), position: n.getStart(tree), ...fields });
    }
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) {
      if (n.moduleSpecifier && ts.isStringLiteralLike(n.moduleSpecifier)) {
        const names = [];
        const clause = n.importClause;
        if (clause?.name) names.push({ imported: "default", local: clause.name.text });
        for (const el of (clause?.namedBindings ?? n.exportClause)?.elements ?? [])
          names.push({ imported: (el.propertyName ?? el.name).text, local: el.name.text });
        reference({ kind: "imports", target: n.moduleSpecifier.text, lang: "js", names });
      }
    }
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const e = n.expression;
      if (e.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(e) && e.text === "require")) {
        const arg = n.arguments?.[0];
        if (arg && ts.isStringLiteralLike(arg))
          reference({ kind: "imports", lang: "js", target: arg.text, names: [] });
        else limitations.add("computed-import");
      } else if (ts.isIdentifier(e)) reference({ kind: "calls", target: e.text });
      else limitations.add("dynamic-dispatch");
    }
    if (ts.isClassDeclaration(n)) {
      for (const clause of n.heritageClauses ?? []) {
        if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
        for (const base of clause.types) {
          if (ts.isIdentifier(base.expression))
            reference({
              kind: "inherits",
              target: base.expression.text,
              position: base.getStart(tree),
            });
          else limitations.add("dynamic-base");
        }
      }
    }
    ts.forEachChild(n, (child) => visit(child, owner));
  }
  visit(tree, -1);
  return { defs, refs, limitations: [...limitations].sort() };
}
const rows = JSON.parse(readFileSync(0, "utf8"));
process.stdout.write(
  JSON.stringify(
    rows.map((row) => {
      try {
        return parse(row);
      } catch {
        return { reason: "syntax-limit" };
      }
    }),
  ),
);
