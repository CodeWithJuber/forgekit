// The checker sees only the bounded source snapshot passed on stdin. No project
// plugins, config executables, dependency packages or files on disk are loaded.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { posix } from "node:path";

const ts = createRequire(import.meta.url)(process.argv[2]);
const { files, aliases } = JSON.parse(readFileSync(0, "utf8"));
const base = "/project";
const sources = new Map(files.map((f) => [posix.join(base, f.file), f.text]));
const directories = new Set([base]);
for (const key of sources.keys()) {
  let dir = posix.dirname(key);
  while (!directories.has(dir)) {
    directories.add(dir);
    dir = posix.dirname(dir);
  }
}
const options = {
  allowJs: true,
  checkJs: true,
  noEmit: true,
  noLib: true,
  types: [],
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.Latest,
  jsx: ts.JsxEmit.Preserve,
  paths: Object.fromEntries(
    aliases
      .filter((a) => !a.fallback)
      .map((a) => [a.pattern, a.targets.map((t) => posix.join(base, t))]),
  ),
};
const fallback = aliases.find((a) => a.fallback);
if (fallback) options.baseUrl = posix.dirname(posix.join(base, fallback.targets[0]));
const host = {
  getSourceFile(name, version) {
    const source = sources.get(name);
    return source === undefined ? undefined : ts.createSourceFile(name, source, version, true);
  },
  getDefaultLibFileName: () => "",
  writeFile() {},
  getCurrentDirectory: () => base,
  getCanonicalFileName: (name) => name,
  useCaseSensitiveFileNames: () => true,
  getNewLine: () => "\n",
  fileExists: (name) => sources.has(name),
  readFile: (name) => sources.get(name),
  directoryExists: (name) => directories.has(name),
};
const program = ts.createProgram([...sources.keys()], options, host);
const checker = program.getTypeChecker();
function location(decl) {
  while (decl && !ts.isSourceFile(decl)) {
    if (
      decl.name &&
      ts.isIdentifier(decl.name) &&
      (ts.isFunctionDeclaration(decl) ||
        ts.isMethodDeclaration(decl) ||
        ts.isGetAccessor(decl) ||
        ts.isSetAccessor(decl) ||
        ts.isClassDeclaration(decl) ||
        ts.isInterfaceDeclaration(decl) ||
        ts.isTypeAliasDeclaration(decl) ||
        ts.isEnumDeclaration(decl) ||
        ts.isVariableDeclaration(decl))
    ) {
      const tree = decl.getSourceFile();
      return {
        file: posix.relative(base, tree.fileName),
        name: decl.name.text,
        line: tree.getLineAndCharacterOfPosition(decl.name.getStart(tree)).line + 1,
      };
    }
    // Only the enclosing declaration of a function expression or constructor
    // represents that callable. Avoid labeling anonymous callbacks as their parent.
    if (
      !(
        ts.isArrowFunction(decl) ||
        ts.isFunctionExpression(decl) ||
        ts.isConstructorDeclaration(decl)
      )
    )
      break;
    decl = decl.parent;
  }
  return null;
}
function symbolTarget(node) {
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
}
const sites = [];
const stats = { files: files.length, calls: 0, types: 0, unresolved: 0 };
for (const tree of program.getSourceFiles()) {
  const file = posix.relative(base, tree.fileName);
  function visit(n, owner) {
    const own = n.name ? location(n) : null;
    const from = own ?? owner;
    let kind, decl, spelling;
    if (ts.isNewExpression(n) || ts.isCallExpression(n)) {
      if (n.expression.kind !== ts.SyntaxKind.ImportKeyword) {
        kind = "calls";
        decl = checker.getResolvedSignature(n)?.getDeclaration();
        // A class without an explicit constructor has a synthetic signature.
        if (!decl && ts.isNewExpression(n)) decl = symbolTarget(n.expression);
        spelling = ts.isIdentifier(n.expression) ? n.expression.text : null;
      }
    } else if (ts.isTypeReferenceNode(n) || ts.isExpressionWithTypeArguments(n)) {
      const name = n.typeName ?? n.expression;
      kind =
        ts.isExpressionWithTypeArguments(n) && n.parent?.token === ts.SyntaxKind.ExtendsKeyword
          ? "inherits"
          : "references";
      decl = symbolTarget(name);
      spelling = ts.isIdentifier(name) ? name.text : null;
    }
    if (kind) {
      const to = location(decl);
      const line = tree.getLineAndCharacterOfPosition(n.getStart(tree)).line + 1;
      if (to) {
        if (kind === "calls") stats.calls++;
        else stats.types++;
      } else stats.unresolved++;
      // Record unresolved call sites too: a lexical name guess cannot override
      // the checker's failure to resolve the actual symbol at this position.
      if (to || spelling)
        sites.push({ from, to, kind, spelling, line, position: n.getStart(tree) });
      if (sites.length > 50000) throw new Error("compiler edge budget exceeded");
    }
    ts.forEachChild(n, (child) => visit(child, from));
  }
  visit(tree, { file });
}
process.stdout.write(JSON.stringify({ sites, stats }));
