// GitHub Copilot's coding agent reads the root AGENTS.md natively (since 2025-08-28).
export default {
  tool: 'Copilot',
  emit(ctx) {
    return { tool: this.tool, target: 'AGENTS.md', action: 'relies-on-agents', note: 'coding agent reads root AGENTS.md' };
  },
};
