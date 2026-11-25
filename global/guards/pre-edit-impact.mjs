// Claude invokes this for one named edit. Host adapters supply the complete patch
// inventory after the path guards have approved each target.
import { checkPreEdit, editIntent } from "../../src/pre_edit.js";

if (process.env.FORGE_GATE !== "advisory") {
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) throw new Error("Split the operation to fit the 4 MiB hook input limit.");
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const batch = process.argv[2] === "--batch";
    const result = await checkPreEdit({
      cwd: body.cwd ?? process.cwd(),
      session: body.session_id,
      paths: batch ? body.paths : [body.tool_input?.file_path ?? body.tool_input?.notebook_path],
      intent: batch ? body.intent : editIntent(body.tool_name, body.tool_input),
    });
    if (!result.allow) throw new Error(result.reason);
    if (!result.id) {
      const scope = result.plan.fullSuite ? "full suite" : result.plan.tests.join(", ");
      process.stdout.write(JSON.stringify({ hookSpecificOutput: {
        hookEventName: "PreToolUse", additionalContext: "Edit impact scope: " + scope,
      } }));
    }
  } catch (error) {
    process.stderr.write("ForgeKit pre-edit impact: " + error.message + "\n");
    process.exitCode = 2;
  }
}
