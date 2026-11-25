// Use the production reverse walker on a parent snapshot. Labels never enter this process.
import { readFileSync } from "node:fs";
import { build, EDGE_WEIGHT, impact } from "../../src/atlas.js";

const [root, configPath] = process.argv.slice(2);
const { sources, tests, weights } = JSON.parse(readFileSync(configPath, "utf8"));
const atlas = build({ root, persist: false });
const modes = weights ? ["calibrated"] : ["fixed", "unweighted"];
const uniform = Object.fromEntries(Object.keys(EDGE_WEIGHT).map((kind) => [kind, 1]));
const result = {};
for (const mode of modes) {
  const graph =
    mode === "unweighted"
      ? { ...atlas, edges: atlas.edges.map((e) => ({ ...e, confidence: 1 })) }
      : atlas;
  const priors = mode === "unweighted" ? uniform : { ...EDGE_WEIGHT, ...weights };
  const byTest = Object.fromEntries(tests.map((file) => [file, { score: 0, path: [] }]));
  for (const source of sources) {
    for (const hit of impact(graph, source, { edgeWeights: priors, relations: ["reverse"] })
      .impacted) {
      const entry = byTest[hit.node.file];
      if (entry && hit.confidence > entry.score) {
        entry.score = hit.confidence;
        entry.path = hit.edgeKinds;
      }
    }
  }
  result[mode] = byTest;
}
process.stdout.write(JSON.stringify(result));
