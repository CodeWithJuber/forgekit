// The native Kimi plugin runs per user; repo MCP configuration is emitted by emit/mcp.js.
export default {
  tool: "Kimi Code",
  emit(_ctx) {
    return {
      tool: this.tool,
      target: "AGENTS.md",
      action: "relies-on-agents",
      note: "reads root AGENTS.md; install ForgeKit in /plugins for automatic prompt hooks",
    };
  },
};
