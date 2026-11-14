// Deliberately separate from model-callable tools: sharing and correcting memory
// represent the local operator's decision. Scope is selected on this invocation.
import { readHarnessConfigData } from "./harness_config_data.js";
import { createHarnessMemory } from "./harness_memory.js";

export function harnessMemoryCommand(root, argv) {
  const [action = "stats", ...args] = argv;
  const values = [];
  let personal = false,
    team = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--personal") personal = true;
    else if (args[i] === "--team") {
      team = args[++i];
      if (!team || team.startsWith("--")) throw new Error("--team requires a team name");
    } else values.push(args[i]);
  }
  const store = createHarnessMemory(root, { personal, team });
  const [a, b, c] = values;
  if (action === "stats" && !values.length) return store.stats();
  if (action === "review" && !values.length) return store.review();
  if (action === "recall" && values.length) return store.recall(values.join(" "));
  if (action === "history" && values.length === 1) return store.history(a);
  if (action === "receipt" && values.length === 1) return store.receipt(a);
  if (action === "graph" && [1, 2].includes(values.length))
    return store.graph(a, { depth: b ? Number(b) : 1 });
  if (action === "correct" && values.length === 1)
    return store.correct(readHarnessConfigData(a, { root }));
  if (action === "contradict" && values.length === 1)
    return store.contradict(readHarnessConfigData(a, { root }));
  if (action === "share" && values.length === 2) return store.share(a, b);
  if (action === "source-state" && values.length === 1) return store.sourceState(a);
  if (action === "source-delta" && values.length === 3)
    return store.refreshSource(a, readHarnessConfigData(c, { root }), Number(b));
  throw new Error(
    "Use harness memory stats | recall <query> | review | history <id> | receipt <id> | graph <id> [1|2] | correct <file> | contradict <file> | share <id> personal|team [--personal|--team <name>] | source-state <source> | source-delta <source> <revision> <file>",
  );
}
