// Kimi Code CLI (MoonshotAI/kimi-cli) reads AGENTS.md natively: its system prompt carries
// `${KIMI_AGENTS_MD}`, documented as the "merged AGENTS.md content from project root to working
// directory (including .kimi/AGENTS.md)" (kimi-cli docs, customization/agents.md, verified
// 2026-10). So the canonical source reaches Kimi with no second instruction file — same deal as
// Codex, Copilot and OpenClaw. Forge writes nothing Kimi-specific: no `.kimi/AGENTS.md` copy
// (it would be merged in TWICE), no hooks, and no MCP entry (not verified for a repo-local
// file, so not claimed).
export default {
  tool: "Kimi Code",
  emit(_ctx) {
    return {
      tool: this.tool,
      target: "AGENTS.md",
      action: "relies-on-agents",
      note: "reads root AGENTS.md natively (merged root → working dir)",
    };
  },
};
