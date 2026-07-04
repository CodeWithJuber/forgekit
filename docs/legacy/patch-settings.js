#!/usr/bin/env node
// Safe, reversible edits to ~/.claude/settings.json:
//  - model -> sonnet (was opus[1m]); use Opus per-session for hard work
//  - add statusLine + PreToolUse/PostToolUse hooks (keeps existing Stop hook)
//  - prune one-off junk from permissions.allow (removed entries saved to a file)
// Does NOT touch mcpServers / the GitHub token — rotate that yourself.
const fs = require('fs');
const HOME = process.env.HOME;
const p = HOME + '/.claude/settings.json';
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
const changes = [];

if (s.model !== 'sonnet') { changes.push(`model: ${s.model} -> sonnet`); s.model = 'sonnet'; }

if (!s.statusLine) {
  s.statusLine = { type: 'command', command: 'bash ~/.claude/statusline.sh' };
  changes.push('added statusLine');
}

s.hooks = s.hooks || {};
if (!s.hooks.PreToolUse) {
  s.hooks.PreToolUse = [{ matcher: 'Edit|Write|MultiEdit|Bash',
    hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/protect-paths.sh' }] }];
  changes.push('added PreToolUse hook (protect-paths)');
}
if (!s.hooks.PostToolUse) {
  s.hooks.PostToolUse = [{ matcher: 'Edit|Write|MultiEdit',
    hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/format-on-edit.sh' }] }];
  changes.push('added PostToolUse hook (format-on-edit)');
}

const block = ['rsync', 'ssh -i', 'perl -C', 'eslint src', 'node_modules/.bin/eslint',
  'tee /tmp', 'xargs -0 perl', 'echo "===', '.gemini', '.cursor', '.codex', 'opencode',
  'ed25519', 'Skill(loop'];
if (s.permissions && Array.isArray(s.permissions.allow)) {
  const before = s.permissions.allow.length;
  const removed = [];
  s.permissions.allow = s.permissions.allow.filter(a => {
    const hit = block.some(b => a.includes(b));
    if (hit) removed.push(a);
    return !hit;
  });
  const dump = `${HOME}/.claude/allow-pruned-${Date.now()}.json`;
  fs.writeFileSync(dump, JSON.stringify(removed, null, 2));
  changes.push(`pruned permissions.allow: ${before} -> ${s.permissions.allow.length} (${removed.length} removed; saved to ${dump})`);
}

fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
JSON.parse(fs.readFileSync(p, 'utf8')); // validate round-trip
console.log('OK\n' + changes.join('\n'));
