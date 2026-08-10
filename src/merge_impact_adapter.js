import { extname } from "node:path";
import { analyzeMergeImpact } from "./merge_impact.js";

const DOC_EXTS = new Set([".md", ".mdx", ".rst", ".adoc"]);
const CONFIG_EXTS = new Set([".json", ".yaml", ".yml", ".toml", ".ini", ".cfg"]);
const TEST_RE = /(^|\/)(?:test|tests|spec|specs)(\/|$)|(?:^|\.)test\.[^.]+$|(?:^|\.)spec\.[^.]+$/i;
const WORKFLOW_RE = /(^|\/)\.github\/workflows\/|(?:^|\/)(?:Jenkinsfile|Dockerfile)$/i;
const DEPENDENCY_RE =
  /(^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.toml|Cargo\.lock|requirements(?:-[^/]+)?\.txt|pyproject\.toml|poetry\.lock|go\.mod|go\.sum|pom\.xml|build\.gradle(?:\.kts)?|Gemfile(?:\.lock)?|composer\.json|composer\.lock)$/i;
const SCHEMA_PATH_RE = /(?:^|\/)(?:schema|schemas|migrations?|openapi|swagger)(?:\/|\.|$)/i;
const GENERATED_PATH_RE = /(?:^|\/)(?:generated|dist|build|coverage)(?:\/|$)|\.generated\./i;
const PUBLIC_API_RE =
  /\b(?:export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)|module\.exports|exports\.[A-Za-z_$]|pub\s+(?:fn|struct|enum|trait|mod|const|static|type)|public\s+(?:class|interface|record|enum)|__all__\s*=|@(?:Get|Post|Put|Patch|Delete|RequestMapping)\b)/;
const SCHEMA_TEXT_RE =
  /\b(?:schema|openapi|swagger|migration|CREATE\s+TABLE|ALTER\s+TABLE|required\s*:|properties\s*:|type\s*:\s*["']?(?:object|array|string|number|integer|boolean))\b/i;
const SECURITY_RE =
  /\b(?:auth(?:entication|orization)?|permission|role|scope|token|secret|password|credential|session|cookie|csrf|cors|crypto|encrypt|decrypt|sign(?:ature)?|verify|acl|rbac|oauth|jwt)\b/i;
const DEPENDENCY_TEXT_RE =
  /["']?(?:dependencies|devDependencies|peerDependencies|optionalDependencies)["']?\s*:|\b(?:version|image)\s*:/i;

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

export function artifactKind(path = "") {
  const normalized = String(path).replaceAll("\\", "/");
  const ext = extname(normalized).toLowerCase();
  if (TEST_RE.test(normalized)) return "test";
  if (DOC_EXTS.has(ext)) return "documentation";
  if (WORKFLOW_RE.test(normalized)) return "workflow";
  if (DEPENDENCY_RE.test(normalized)) return "manifest";
  if (SCHEMA_PATH_RE.test(normalized)) return "schema";
  if (CONFIG_EXTS.has(ext)) return "config";
  return "source";
}

function changedLines(patch = "") {
  const added = [];
  const removed = [];
  for (const line of String(patch).split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added.push(line.slice(1));
    else if (line.startsWith("-")) removed.push(line.slice(1));
  }
  return { added, removed };
}

function compact(lines) {
  return lines.join("").replace(/\s+/g, "").replace(/,([)\]}])/g, "$1");
}

function formattingOnly(added, removed) {
  if (!added.length || !removed.length) return false;
  const before = compact(removed);
  const after = compact(added);
  return Boolean(before) && before === after;
}

function mergeSignal(base, extra) {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) out[key] = Math.max(out[key] || 0, value);
  return out;
}

export function classifyChangedFile(file = {}) {
  const filename = String(file.filename || file.path || "").replaceAll("\\", "/");
  const patch = String(file.patch || "");
  const { added, removed } = changedLines(patch);
  const text = [...added, ...removed].join("\n");
  const linesChanged =
    Number(file.changes) ||
    Number(file.additions || 0) + Number(file.deletions || 0) ||
    added.length + removed.length ||
    1;
  const reasons = [];
  let kind = "logic";
  let confidence = 0.62;
  let signal = {};

  if (formattingOnly(added, removed)) {
    kind = "formatting";
    confidence = 0.98;
    reasons.push("token sequence is unchanged after whitespace normalization");
  } else if (TEST_RE.test(filename)) {
    kind = "test";
    confidence = 0.98;
    reasons.push("test/spec path");
  } else if (DOC_EXTS.has(extname(filename).toLowerCase())) {
    kind = "docs";
    confidence = 0.99;
    reasons.push("documentation extension");
  } else if (WORKFLOW_RE.test(filename)) {
    kind = "ci";
    confidence = 0.98;
    reasons.push("delivery/workflow path");
  } else if (DEPENDENCY_RE.test(filename) || DEPENDENCY_TEXT_RE.test(text)) {
    kind = "dependency";
    confidence = DEPENDENCY_RE.test(filename) ? 0.97 : 0.82;
    reasons.push("dependency/manifest surface");
  } else if (SCHEMA_PATH_RE.test(filename) || SCHEMA_TEXT_RE.test(text)) {
    kind = "schema";
    confidence = SCHEMA_PATH_RE.test(filename) ? 0.94 : 0.76;
    reasons.push("schema or migration semantics");
  } else if (PUBLIC_API_RE.test(text)) {
    kind = "public_api";
    confidence = 0.86;
    reasons.push("exported/public contract changed");
  } else if (CONFIG_EXTS.has(extname(filename).toLowerCase())) {
    kind = "config";
    confidence = 0.9;
    reasons.push("configuration artifact");
  } else if (GENERATED_PATH_RE.test(filename)) {
    kind = "generated";
    confidence = 0.88;
    reasons.push("generated artifact path");
  } else {
    reasons.push("executable/source delta without a stronger structural classifier");
  }

  if (SECURITY_RE.test(text)) {
    signal = mergeSignal(signal, {
      runtime: 0.82,
      contract: 0.72,
      verification: 0.96,
      delivery: 0.62,
    });
    confidence = Math.max(confidence, 0.78);
    reasons.push("security-sensitive vocabulary changed");
  }

  const destructiveRatio = clamp01(
    (Number(file.deletions) || removed.length) / Math.max(1, linesChanged),
  );
  if (destructiveRatio > 0.65 && !["formatting", "docs", "test"].includes(kind)) {
    signal = mergeSignal(signal, { contract: 0.68, verification: 0.78, merge: 0.22 });
    reasons.push("change is deletion-heavy");
  }

  return {
    artifact: filename,
    kind,
    linesChanged,
    signal,
    confidence,
    reasons,
  };
}

export function changeAtomsFromDiff(files = []) {
  return files.filter((file) => file?.filename || file?.path).map(classifyChangedFile);
}

function relationKey(relation) {
  return `${relation.from}\0${relation.to}\0${relation.kind}`;
}

function atlasNodeMap(atlas) {
  return new Map((atlas?.nodes || []).map((node) => [node.id, node]));
}

export function atlasEvidence(atlas, { criticality = {}, generatedTargets = {} } = {}) {
  const nodes = atlasNodeMap(atlas);
  const artifactMap = new Map();
  const relations = new Map();

  const addArtifact = (file, nodeKind) => {
    if (!file) return;
    const existing = artifactMap.get(file);
    const inferred = nodeKind === "doc" ? "documentation" : artifactKind(file);
    if (!existing) {
      artifactMap.set(file, {
        id: file,
        kind: inferred,
        criticality: clamp01(criticality[file] || 0),
      });
    }
  };

  for (const node of nodes.values()) addArtifact(node.file, node.kind);

  for (const edge of atlas?.edges || []) {
    if (edge.unresolved || edge.kind === "contains") continue;
    const sourceNode = nodes.get(edge.source);
    const targetNode = nodes.get(edge.target);
    const sourceFile = sourceNode?.file;
    const targetFile = targetNode?.file;
    if (!sourceFile || !targetFile || sourceFile === targetFile) continue;
    addArtifact(sourceFile, sourceNode.kind);
    addArtifact(targetFile, targetNode.kind);

    const sourceKind = artifactMap.get(sourceFile)?.kind;
    let kind;
    if (sourceKind === "test") kind = "verified_by";
    else if (sourceKind === "documentation") kind = "documented_by";
    else if (sourceKind === "workflow") kind = "workflow_uses";
    else if (["config", "manifest", "schema"].includes(sourceKind)) kind = "configures";
    else if (["calls", "imports", "inherits"].includes(edge.kind)) kind = edge.kind;
    else continue;

    // Atlas edges say source depends on target. Consequence flows the opposite way.
    const relation = {
      from: targetFile,
      to: sourceFile,
      kind,
      confidence: clamp01(edge.confidence ?? 0.7),
    };
    const key = relationKey(relation);
    const prior = relations.get(key);
    if (!prior || relation.confidence > prior.confidence) relations.set(key, relation);
  }

  for (const [generator, targets] of Object.entries(generatedTargets || {})) {
    addArtifact(generator, "source");
    for (const target of targets || []) {
      addArtifact(target, "doc");
      const relation = { from: generator, to: target, kind: "generates", confidence: 0.98 };
      relations.set(relationKey(relation), relation);
    }
  }

  return { artifacts: [...artifactMap.values()], relations: [...relations.values()] };
}

export function analyzeDiffImpact({
  files = [],
  atlas = null,
  criticality = {},
  generatedTargets = {},
  extraRelations = [],
} = {}) {
  const changes = changeAtomsFromDiff(files);
  const evidence = atlasEvidence(atlas, { criticality, generatedTargets });
  const artifactMap = new Map(evidence.artifacts.map((artifact) => [artifact.id, artifact]));
  for (const change of changes) {
    if (!artifactMap.has(change.artifact)) {
      artifactMap.set(change.artifact, {
        id: change.artifact,
        kind: artifactKind(change.artifact),
        criticality: clamp01(criticality[change.artifact] || 0),
      });
    }
  }

  const result = analyzeMergeImpact({
    artifacts: [...artifactMap.values()],
    changes,
    relations: [...evidence.relations, ...extraRelations],
  });

  return {
    ...result,
    changes,
    evidence: {
      atlasRelations: evidence.relations.length,
      extraRelations: extraRelations.length,
      generatedRelations: Object.values(generatedTargets || {}).reduce(
        (sum, targets) => sum + (targets?.length || 0),
        0,
      ),
    },
  };
}
