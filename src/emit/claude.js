// Claude Code reads CLAUDE.md, not AGENTS.md. Emit a thin CLAUDE.md that imports
// the shared source via @AGENTS.md (first line, Windows-safe). If the repo already has its OWN
// CLAUDE.md, ADOPT it rather than skip: prepend the one-line @AGENTS.md import (idempotent) so
// Forge's shared rules actually reach Claude Code, while preserving every line the user wrote.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const IMPORTS_AGENTS = /^\s*@AGENTS\.md\b/m;

export default {
  tool: "Claude Code",
  emit(ctx) {
    const path = join(ctx.targetRoot, "CLAUDE.md");
    const existing = ctx.shared.readIfExists(path);
    // A user's own (unmanaged) CLAUDE.md: adopt it by wiring in the shared import, non-destructively.
    if (existing !== null && !ctx.shared.isManaged(existing)) {
      if (IMPORTS_AGENTS.test(existing)) {
        return {
          tool: this.tool,
          target: "CLAUDE.md",
          action: "unchanged",
          note: "your CLAUDE.md already imports @AGENTS.md",
        };
      }
      writeFileSync(path, `@AGENTS.md\n\n${existing.replace(/^﻿/, "")}`);
      return {
        tool: this.tool,
        target: "CLAUDE.md",
        action: "adopted",
        note: "prepended @AGENTS.md import to your existing CLAUDE.md (content preserved)",
      };
    }
    const content = [
      "@AGENTS.md",
      "",
      ctx.shared.mdHeader(ctx.hash),
      "",
      "> Claude reads the shared rules via the import above. Add Claude-only or repo-specific notes below.",
      "",
    ].join("\n");
    const action = ctx.shared.writeIfChanged(path, content);
    return { tool: this.tool, target: "CLAUDE.md", action, note: "@AGENTS.md import" };
  },
};
