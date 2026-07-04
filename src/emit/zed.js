// Zed uses the FIRST match of a precedence list; several legacy files outrank
// AGENTS.md. Warn if any of them exist so AGENTS.md actually wins.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const EARLIER = ['.rules', '.cursorrules', '.windsurfrules', '.clinerules', '.github/copilot-instructions.md', 'AGENT.md'];

export default {
  tool: 'Zed',
  emit(ctx) {
    const shadow = EARLIER.filter((f) => existsSync(join(ctx.targetRoot, f)));
    if (shadow.length) {
      return { tool: this.tool, target: 'AGENTS.md', action: 'warn', note: `shadowed by ${shadow.join(', ')} (Zed uses first match)` };
    }
    return { tool: this.tool, target: 'AGENTS.md', action: 'relies-on-agents', note: 'AGENTS.md wins precedence' };
  },
};
