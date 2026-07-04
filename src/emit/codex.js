// Codex reads AGENTS.md natively but hard-truncates past 32 KiB (project_doc_max_bytes).
const CAP = 32 * 1024;

export default {
  tool: 'Codex',
  emit(ctx) {
    const over = ctx.bytes > CAP;
    return {
      tool: this.tool,
      target: 'AGENTS.md',
      action: over ? 'warn' : 'relies-on-agents',
      note: over ? `${ctx.bytes} B exceeds 32 KiB cap — will truncate` : `native (${ctx.bytes}/${CAP} B)`,
    };
  },
};
