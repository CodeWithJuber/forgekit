#!/usr/bin/env node
// PreToolUse guard — block reads/edits of secret/credential files and obviously destructive
// Bash. The whole rule set lives in Node (the secret-redact.sh → secret-redact.mjs pattern),
// for three reasons the shell version could not give:
//   1. ONE parser. The shell guard read its payload with jq, else a regex that stopped at the
//      first escaped quote — `echo "x"; cat .env` arrived as `echo \`, so every rule after it
//      silently missed (2 review-found bypasses, reproduced here as tests).
//   2. NO pipeline hazards. `printf … | grep -q` under `pipefail` fails when grep exits early
//      and printf takes SIGPIPE, so on a LARGE command the deny did not fire.
//   3. FAIL CLOSED. Exit 1 is a non-blocking hook error in Claude Code; `set -e` turned every
//      internal hiccup into a silent pass. Here any error denies with a reason (exit 2).
//
// Secret paths are matched per PATH TOKEN, never as a substring of the command: the command is
// split into shell words (quotes honoured), each simple command's FILE operands are found, and
// only those are tested. So `grep -rn process.env src`, `rg 'import\.meta\.env'`, `.env.example`
// and `messages.key.ts` pass, while `.env`, `.env.local`, `id_rsa`, `*.pem` and `*.key` stay
// blocked.
//
// The string of `sh -c …` / `eval …` is checked as a command line of its own, brace alternation
// (`.{env,x}`) is expanded, and the literal output of `$(echo …)` counts as part of its word.
//
// SCOPE: pattern matching, not a sandbox. A word splitter cannot evaluate shell, so indirection
// (`f=.env; cat $f`, `find … -exec cat {}`, `xargs -a .env`, any other command substitution)
// and interpreter-driven access (`python -c 'open(".env")…'`, `node -e …`) are DELIBERATELY out
// of scope. This layer sits behind the permission system and secret-redact.sh: best-effort
// hardening, never a boundary.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * @typedef {{cwd?: string, home?: string, readText?: (absPath: string) => string | null}} FsCtx
 * `bash`: the path is a Bash word. `dir`: it is searched RECURSIVELY (grep -r, rg, the Grep
 * tool), so a `secrets` directory itself is a secret store. `cwdUnknown`: the command changes
 * directory first, so a relative path cannot be resolved against the payload's cwd.
 * @typedef {FsCtx & {bash?: boolean, dir?: boolean, cwdUnknown?: boolean}} PathCtx
 * `brace`: an unquoted `{` (bash brace expansion). `subst`: the literal output of a
 * `$(echo …)`/`$(printf …)` inside the word.
 * @typedef {{text: string, glob: boolean, quoted: boolean, brace?: boolean, subst?: string[]}} Word
 * @typedef {{op: string, target: Word}} Redirect
 * @typedef {{words: Word[], redirs: Redirect[]}} Segment
 */

// ── What is a secret path. ONE predicate for a tool's path (Read/Edit/Grep/…) and for every
// file operand of a Bash command. Paths are compared with forward slashes (Claude Code sends
// native Windows paths) and case-insensitively (NTFS is; a `.ENV` is still a secret on POSIX).

/** Suffixes that mark a committed TEMPLATE of an env file (`.env.example`), never the real one. */
const ENV_TEMPLATE = new Set(["example", "sample", "template", "dist", "defaults"]);
/** Source and docs a `secrets/` directory legitimately holds in an app — a Next.js
 *  `app/docs/secrets/page.tsx` route, a Django `secrets` app. Code, not a secret store. */
const CODE_FILE =
  /\.(?:[cm]?[jt]sx?|vue|svelte|astro|mdx?|css|scss|sass|less|html?|py|rb|go|rs|java|kts?|swift|php|cs|c|cc|cpp|h|hpp|dart|exs?|scala|lua)$/i;
const SECRET_DIR = "path under secrets/ or .ssh/";

/** Forward slashes, no trailing slash (a trailing slash names the directory itself).
 *  @param {string} s */
const slashes = (s) =>
  String(s)
    .replaceAll("\\", "/")
    .replace(/(.)\/+$/, "$1");

/**
 * The kind of protected secret `raw` names, or null. In a Bash word (`ctx.bash`) a backslash is
 * usually regex text (`process\.env`), so only a drive/UNC-shaped word is re-slashed, and a bare
 * `name.env` is NOT an env file there: it is indistinguishable from `process.env`.
 * @param {string} raw
 * @param {PathCtx} [ctx]
 * @returns {string | null}
 */
export function secretKind(raw, ctx = {}) {
  const text = String(raw ?? "");
  const p =
    !ctx.bash || /^[A-Za-z]:\\|^\\\\/.test(text) ? slashes(text) : text.replace(/(.)\/+$/, "$1");
  if (!p) return null;
  const segs = p.split("/");
  const base = segs[segs.length - 1];
  const lower = segs.map((s) => s.toLowerCase());
  // `.env`, `.env.local`, `.env-local`, `.env-prod.local` — but not the `.env.example` template.
  const env = /^\.env((?:[.-][\w-]+)*)~?$/i.exec(base);
  if (env) {
    if (!ENV_TEMPLATE.has(env[1].split(/[.-]/).pop()?.toLowerCase() ?? "")) return "env file";
  } else if (/.\.env$/i.test(base) && (!ctx.bash || segs.length > 1)) {
    return "env file"; // `prod.env`, `docker/app.env`
  }
  if (
    /^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?$/i.test(base) ||
    /\.(?:pem|key)(?:\.(?:bak|old|orig|backup|save|tmp))?~?$/i.test(base)
  )
    return "credential/key file";
  if (lower.includes(".ssh")) return SECRET_DIR;
  if (lower.slice(0, -1).includes("secrets") && !CODE_FILE.test(base)) return SECRET_DIR;
  // A recursive search of the store itself (`grep -r KEY ./secrets/`, Grep on /run/secrets)
  // reads every file in it; the code-file exemption above is for single files like page.tsx.
  if (ctx.dir && lower.at(-1) === "secrets") return SECRET_DIR;
  if (
    /^(?:\.netrc|_netrc|\.git-credentials)$/i.test(base) ||
    (lower.at(-2) === ".aws" && lower.at(-1) === "credentials")
  )
    return "credential store";
  if (/^\.npmrc$/i.test(base) && npmrcIsSecret(p, ctx)) return "credential store";
  return null;
}

/**
 * True iff an npmrc's text carries a literal registry credential. `${NPM_TOKEN}` — the usual CI
 * spelling — references the environment and holds no secret, so it does not count.
 * @param {string} text
 */
export function npmrcHasToken(text) {
  const auth = /^[ \t]*(?:[^\s=#;]*:)?_(?:authToken|auth|password)[ \t]*=[ \t]*(.*)$/gim;
  for (const m of String(text).matchAll(auth)) {
    const v = m[1].trim().replace(/^(["'])(.*)\1$/, "$2");
    if (v && !/^\$\{[A-Za-z_]\w*\}$/.test(v)) return true;
  }
  return false;
}

/**
 * A project `.npmrc` is ordinary config (`registry=`, `engine-strict=`) and reading it is
 * routine; only one holding a literal token is a credential store. The user-level npmrc is where
 * `npm login` writes the token, so it is always protected, and so is any spelling this guard
 * cannot resolve (`$DIR/.npmrc`, or a relative one after `cd`): fail closed.
 * @param {string} p forward-slashed path
 * @param {PathCtx} ctx
 */
function npmrcIsSecret(p, ctx) {
  if (/^~[^/]*\//.test(p) || /^\$\{?HOME\}?\//.test(p)) return true;
  if (/[$`]/.test(p)) return true;
  // `cd ~ && cat .npmrc`: the payload cwd is no longer where a relative path points.
  if (ctx.cwdUnknown && !/^(?:[A-Za-z]:)?\//.test(p)) return true;
  const home = slashes(ctx.home ?? homedir()).toLowerCase();
  const abs = slashes(/^(?:[A-Za-z]:)?\//.test(p) ? p : resolve(ctx.cwd ?? process.cwd(), p));
  if (abs.slice(0, abs.lastIndexOf("/")).toLowerCase() === home) return true;
  return npmrcHasToken((ctx.readText ?? readHead)(abs) ?? "");
}

/**
 * The first MiB of a regular file, or null. Never opens a FIFO or a device: a blocking read
 * would hang the hook.
 * @param {string} p
 */
function readHead(p) {
  let fd;
  try {
    if (!statSync(p).isFile()) return null;
    fd = openSync(p, "r");
    const buf = Buffer.alloc(1 << 20);
    return buf.toString("utf8", 0, readSync(fd, buf, 0, buf.length, 0));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// ── Globs. `cat .e*v` reads `.env` without ever spelling it, so a wildcard operand is tested
// against representative secret names. The shell never expands `*` to a dotfile, so a `.`-led
// name is only reachable by a glob that itself starts with `.`; a glob with no literal
// characters (`*`, `*.*`) is not a targeted read, so `grep -r x *` stays allowed.
const GLOB_SAMPLES = [
  ".env",
  ".env.local",
  ".env.production",
  ".env-local",
  "prod.env",
  "id_rsa",
  "id_ed25519",
  "server.pem",
  "server.key",
  ".netrc",
  "_netrc",
  ".git-credentials",
];

/** @param {string} glob one path segment */
function globRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    const close = c === "[" ? glob.indexOf("]", i + 2) : -1;
    if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (close > 0) {
      const body = glob.slice(i + 1, close).replace(/^[!^]/, "^");
      re += `[${body.replaceAll("\\", "\\\\")}]`;
      i = close;
    } else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

/** More alternatives than this and the expansion is not trusted (callers fail closed). */
const BRACE_LIMIT = 64;

/**
 * Brace alternation, as bash and ripgrep/the Grep tool expand it: `*.{env,pem}` →
 * [`*.env`, `*.pem`]. A `{…}` with no top-level comma (`${HOME}`, `{}`) is literal. At most
 * BRACE_LIMIT results; a caller that gets that many treats the word as matching (fail closed).
 * @param {string} s
 * @returns {string[]}
 */
export function expandBraces(s) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} str */
  const walk = (str) => {
    if (out.length >= BRACE_LIMIT) return;
    // One pass, innermost group first (`{a,{b,c}}` → `{a,b}`, `{a,c}` → …): linear per call.
    /** @type {{at: number, cuts: number[]}[]} */
    const open = [];
    for (let k = 0; k < str.length; k++) {
      const ch = str[k];
      if (ch === "{") open.push({ at: k, cuts: [] });
      else if (ch === "," && open.length) open[open.length - 1].cuts.push(k);
      else if (ch === "}" && open.length) {
        const g = /** @type {{at: number, cuts: number[]}} */ (open.pop());
        if (!g.cuts.length) continue;
        let from = g.at + 1;
        for (const cut of [...g.cuts, k]) {
          walk(str.slice(0, g.at) + str.slice(from, cut) + str.slice(k + 1));
          from = cut + 1;
        }
        return;
      }
    }
    out.push(str);
  };
  walk(String(s));
  return out;
}

/**
 * True iff the wildcard pattern `glob` (a shell glob, an `rg -g` glob, the Grep tool's `glob`)
 * can select a protected secret file by name. Brace alternatives are tested one by one, and a
 * literal alternative (`{.env,x}`) is tested as a path.
 * @param {string} glob
 * @param {PathCtx} [ctx]
 */
export function globMatchesSecret(glob, ctx = {}) {
  const g = slashes(glob);
  if (g.startsWith("!")) return false; // an exclusion (`rg -g '!.env'`) never selects a file
  const alts = expandBraces(g);
  if (alts.length >= BRACE_LIMIT) return true;
  return alts.some((alt) => {
    const base = alt.split("/").pop() ?? "";
    // No wildcard in the name: the caller's literal check covers the word itself; an
    // alternative the braces produced gets that check here.
    if (!/[*?[]/.test(base)) return alt !== g && secretKind(alt, ctx) !== null;
    let re;
    try {
      re = globRegExp(base);
    } catch {
      return true; // an unparsable class: fail closed
    }
    const dotted = base.startsWith(".");
    const literal = base.replace(/\[[^\]]*\]|[*?.]/g, "");
    return GLOB_SAMPLES.some(
      (s) => (s.startsWith(".") ? dotted : literal.length > 0) && re.test(s),
    );
  });
}

// ── Shell words. Enough of POSIX sh to find each simple command, its operands and its
// redirections — NOT a parser. Quotes are honoured, so a quoted `;`, `>` or space never splits a
// word, and a quoted `*` is not a glob.

/**
 * Decode a `$'…'` (ANSI-C) string that starts at `cmd[i] === "$"`: `$'\x2eenv'` is `.env`.
 * @param {string} cmd
 * @param {number} i
 */
function ansiC(cmd, i) {
  /** @type {Record<string, string>} */
  const simple = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", f: "\f", v: "\v" };
  let s = "";
  let j = i + 2;
  for (; j < cmd.length && cmd[j] !== "'"; j++) {
    if (cmd[j] !== "\\" || j + 1 >= cmd.length) {
      s += cmd[j];
      continue;
    }
    const e = cmd[++j];
    const hex = /^[0-9a-fA-F]+/.exec(cmd.slice(j + 1, j + (e === "x" ? 3 : 5)));
    const oct = /^[0-7]{1,3}/.exec(cmd.slice(j, j + 3));
    if ((e === "x" || e === "u") && hex) {
      s += String.fromCharCode(Number.parseInt(hex[0], 16));
      j += hex[0].length;
    } else if (oct) {
      s += String.fromCharCode(Number.parseInt(oct[0], 8));
      j += oct[0].length - 1;
    } else s += simple[e] ?? e;
  }
  return { text: s, end: j };
}

/** Shells that execute a heredoc body as code — theirs is scanned instead of skipped. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "fish"]);

/** `/usr/bin/CAT.exe` → `cat`. @param {string} t */
const cmdName = (t) =>
  (t.replaceAll("\\", "/").split("/").pop() ?? "").toLowerCase().replace(/\.exe$/, "");

/**
 * Split a Bash command into simple-command segments. `;` `&` `|` newlines and `( )` end a
 * segment; `$( … )`, backticks and `<( … )` are scanned as nested segments; a heredoc body is
 * skipped as data unless it is fed to a shell. Inside `$(( … ))` / `(( … ))` arithmetic, `<`
 * and `>` are operators (`1<<2` is a shift, not a heredoc) and a newline is not a command end.
 * @param {string} cmd
 * @returns {Segment[]}
 */
export function shellSegments(cmd) {
  /** @type {Segment[]} */
  const done = [];
  /** @returns {{words: Word[], redirs: Redirect[], cur: Word | null, redir: string | null}} */
  const fresh = () => ({ words: [], redirs: [], cur: null, redir: null });
  let ctx = fresh();
  /** @type {{ctx: ReturnType<typeof fresh>, kind: string, dq: boolean, arith: number, start: number}[]} */
  const stack = [];
  let dq = false; // inside "…"
  let arith = -1; // ≥ 0 inside arithmetic: the count of `(` open within it
  /** @type {{delim: string, strip: boolean, exec: boolean}[]} */
  const heredocs = [];
  /** @param {string} s @param {boolean} [glob] @param {boolean} [quoted] */
  const add = (s, glob = false, quoted = false) => {
    ctx.cur ??= { text: "", glob: false, quoted: false };
    ctx.cur.text += s;
    if (glob) ctx.cur.glob = true;
    if (quoted) ctx.cur.quoted = true;
  };
  const endWord = () => {
    const w = ctx.cur;
    if (!w) return;
    ctx.cur = null;
    const op = ctx.redir;
    if (!op) {
      ctx.words.push(w);
      return;
    }
    ctx.redir = null;
    if (op === "<<" || op === "<<-") {
      heredocs.push({
        delim: w.text,
        strip: op === "<<-",
        // `sudo bash <<EOF`: the command past its wrappers, not the literal first word.
        exec: SHELLS.has(commandOf(ctx.words)?.name ?? ""),
      });
    } else ctx.redirs.push({ op, target: w });
  };
  const endSeg = () => {
    endWord();
    if (ctx.words.length || ctx.redirs.length) done.push({ words: ctx.words, redirs: ctx.redirs });
    ctx.words = [];
    ctx.redirs = [];
    ctx.redir = null;
  };
  /** @param {string} kind */
  const open = (kind) => {
    stack.push({ ctx, kind, dq, arith, start: done.length });
    ctx = fresh();
    dq = false;
    arith = kind === "$((" || kind === "((" ? 0 : -1;
  };
  const close = () => {
    endSeg();
    const f = /** @type {(typeof stack)[number]} */ (stack.pop());
    const inner = done.slice(f.start);
    ctx = f.ctx;
    dq = f.dq;
    arith = f.arith;
    if (f.kind === "(" || f.kind === "((") return;
    add("$()"); // an expansion inside a word: no longer a literal path
    // `cat "$(echo .env)"`: the literal words an echo/printf prints are what the word holds.
    const c = inner.length === 1 && !inner[0].redirs.length ? commandOf(inner[0].words) : null;
    if (c && (c.name === "echo" || c.name === "printf") && ctx.cur) {
      const out = c.args.filter((a) => !/^-[neE]+$/.test(a.text)).map((a) => a.text);
      ctx.cur.subst = [...(ctx.cur.subst ?? []), ...out];
      if (c.args.some((a) => a.glob)) ctx.cur.glob = true;
    }
  };
  /** @param {number} i index of the newline ending the line that owns the heredocs */
  const skipHeredocs = (i) => {
    let pos = i + 1;
    for (const h of heredocs) {
      while (pos < cmd.length) {
        let e = cmd.indexOf("\n", pos);
        if (e < 0) e = cmd.length;
        const line = cmd.slice(pos, e);
        pos = e + 1;
        if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
      }
    }
    heredocs.length = 0;
    return pos - 1;
  };
  /** At a command's start (only keywords so far) or after `for`: `((` there opens arithmetic,
   *  not two subshells. */
  const atCommandStart = () =>
    !ctx.cur && ctx.words.every((w) => KEYWORDS.has(w.text) || w.text === "for");
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    const next = cmd[i + 1];
    if (dq) {
      if (c === '"') dq = false;
      else if (c === "\\" && next !== undefined && '"\\$`\n'.includes(next)) {
        if (next !== "\n") add(next, false, true);
        i++;
      } else if (c === "$" && next === "(" && cmd[i + 2] === "(") {
        open("$((");
        i += 2;
      } else if (c === "$" && next === "(") {
        open("$(");
        i++;
      } else if (c === "`") open("`");
      else add(c, false, true);
      continue;
    }
    if (arith >= 0 && "()<>#\n".includes(c)) {
      if (c === "(") arith++;
      else if (c === ")" && arith > 0) arith--;
      else if (c === ")") {
        if (next === ")") i++;
        close();
        continue;
      }
      if (c === "\n") endWord();
      else add(c);
      continue;
    }
    if (c === "\\") {
      if (next !== undefined && next !== "\n") add(next, false, true);
      i++;
    } else if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      const end = j < 0 ? cmd.length : j;
      add(cmd.slice(i + 1, end), false, true);
      i = end;
    } else if (c === '"') {
      dq = true;
      add("", false, true);
    } else if (c === "$" && next === "'") {
      const { text, end } = ansiC(cmd, i);
      add(text, false, true);
      i = end;
    } else if (c === "$" && next === "(" && cmd[i + 2] === "(") {
      open("$((");
      i += 2;
    } else if (c === "$" && next === "(") {
      open("$(");
      i++;
    } else if (c === "`") {
      if (stack.at(-1)?.kind === "`") close();
      else open("`");
    } else if (c === "(" && next === "(" && atCommandStart()) {
      open("((");
      i++;
    } else if (c === "(") open("(");
    else if (c === ")") {
      if (stack.length && stack.at(-1)?.kind !== "`") close();
      else endSeg();
    } else if (c === "\n") {
      endSeg();
      if (heredocs.length) {
        if (heredocs.some((h) => h.exec)) heredocs.length = 0;
        else i = skipHeredocs(i);
      }
    } else if (c === " " || c === "\t" || c === "\r") endWord();
    else if (c === "#" && !ctx.cur) {
      const e = cmd.indexOf("\n", i);
      i = (e < 0 ? cmd.length : e) - 1; // a comment runs to the end of the line
    } else if (c === ";" || c === "|") endSeg();
    else if (c === "&") {
      if (next === ">") {
        endWord();
        i += cmd[i + 2] === ">" ? 2 : 1;
        ctx.redir = ">";
      } else endSeg();
    } else if (c === "<" || c === ">") {
      // `2>file`: a bare number right before the operator is the fd, not an operand.
      if (ctx.cur && !ctx.cur.quoted && /^\d+$/.test(ctx.cur.text)) ctx.cur = null;
      else endWord();
      if (next === "(") {
        open(`${c}(`); // process substitution: a nested command used as a file argument
        i++;
        continue;
      }
      let op = c;
      if (c === "<" && cmd.startsWith("<<<", i)) {
        op = "<<<";
        i += 2;
      } else if (c === "<" && next === "<") {
        op = "<<";
        i++;
        if (cmd[i + 1] === "-") {
          op = "<<-";
          i++;
        }
      } else if (next === ">") {
        op = c === "<" ? "<>" : ">>";
        i++;
      } else if (c === ">" && next === "|") i++;
      else if (next === "&") {
        op = `${c}&`;
        i++;
      }
      ctx.redir = op;
    } else {
      add(c, c === "*" || c === "?" || c === "[");
      if (c === "{") /** @type {Word} */ (ctx.cur).brace = true; // bash brace expansion
    }
  }
  while (stack.length) close();
  endSeg();
  return done;
}

// ── Commands: which word runs, and which of its arguments are FILES it reads or writes.

/** Shell keywords that may precede the command word. */
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{"]);
/** Wrappers that run the next word as the command → their options that take a value.
 *  @type {Record<string, string[]>} */
const WRAPPERS = {
  sudo: [
    "-u",
    "-g",
    "-C",
    "-D",
    "-h",
    "-p",
    "-r",
    "-t",
    "-U",
    "-T",
    "--user",
    "--group",
    "--chdir",
  ],
  doas: ["-u", "-C"],
  env: ["-u", "-C", "-S", "--unset", "--chdir", "--split-string"],
  command: [],
  builtin: [],
  busybox: [],
  exec: ["-a"],
  nohup: [],
  nice: ["-n", "--adjustment"],
  ionice: ["-c", "-n", "-p"],
  stdbuf: ["-i", "-o", "-e"],
  time: ["-f", "-o", "--format", "--output"],
  timeout: ["-s", "-k", "--signal", "--kill-after"],
  xargs: ["-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s", "--arg-file", "--delimiter"],
};

/** Commands that change the working directory for what follows them. */
const CHDIR = new Set(["cd", "pushd", "popd", "chdir"]);
/** A wrapper option that runs the command in another directory: `env -C DIR`, `sudo -D DIR`,
 *  and sudo's login shell (`-i`, alone or in a cluster), which starts in the target's home.
 *  @param {string} name @param {string} a */
const wrapperChdir = (name, a) =>
  (name === "env" && /^(?:-C|--chdir)(?:=|$)/.test(a)) ||
  (name === "sudo" && (/^(?:-D|--chdir|--login)(?:=|$)/.test(a) || /^-[A-Za-z]*i/.test(a)));

/**
 * The command a segment runs, past `VAR=val` prefixes, keywords and wrappers. `chdir`: a
 * wrapper runs it in another directory.
 * @param {Word[]} words
 * @returns {{name: string, args: Word[], chdir: boolean} | null}
 */
function commandOf(words) {
  let i = 0;
  let chdir = false;
  while (i < words.length) {
    const w = words[i];
    // `FOO="a b" cat .env`: an assignment even when its value is quoted.
    if (/^[A-Za-z_]\w*(\[[^\]]*\])?\+?=/.test(w.text) || KEYWORDS.has(w.text)) {
      i++;
      continue;
    }
    const name = cmdName(w.text);
    const values = WRAPPERS[name];
    if (!values) return { name, args: words.slice(i + 1), chdir };
    let positional = name === "timeout" ? 1 : 0; // timeout DURATION cmd…
    for (i++; i < words.length; ) {
      const a = words[i].text;
      if (a === "--") {
        i++;
        break;
      }
      if (a.length > 1 && a.startsWith("-")) {
        if (wrapperChdir(name, a)) chdir = true;
        i += values.includes(a) ? 2 : 1;
      } else if (positional-- > 0) i++;
      else break;
    }
  }
  return null;
}

/**
 * How a command's arguments map to files. `patternFirst`: its first operand is a pattern or a
 * program (grep, sed, awk, jq), not a file. `dirs`: it searches a directory operand recursively
 * (grep, rg, ag, git grep). `strict`: every option value is checked as a path, even the `=`
 * value of an option not listed (`diff --from-file=.env`). `opts` names the options that take a
 * value:
 *   file    — a path (checked); it also supplies the pattern/program (`grep -f`, `sed -f`)
 *   pattern — a pattern or program, not a path; it supplies the pattern (`grep -e`, `sed -e`)
 *   glob    — a file glob, checked as one (`rg -g`, `grep --include`)
 *   value   — a count, size or delimiter, still checked as a path: FAIL CLOSED, because one
 *             table serves many commands and a flag it wrongly lists (`cat -n`) must never
 *             hide the file after it. A real count is never a secret name.
 *   skip    — any other non-path value (`git log --grep`, `rg -t`, `grep -A`)
 *   skip2 / file2 — two-word options (`jq --arg k v` / `jq --rawfile k FILE`)
 *   glued   — an optional value that is only ever glued (`sed -i[SUFFIX]`)
 * Short options are read getopt style: in a cluster (`-rnwe KEY`, `-eKEY`, `-n5`) letters are
 * flags up to the first one that takes a value, which is the rest of the word or else the next
 * word. Any option not listed is a flag.
 * @typedef {{patternFirst?: boolean, dirs?: boolean, strict?: boolean, opts?: Record<string, string>}} ArgSpec
 */
/** @param {string} kind @param {string[]} names */
const kinds = (kind, names) => Object.fromEntries(names.map((n) => [n, kind]));

/** @type {ArgSpec} */
const GREP = {
  patternFirst: true,
  dirs: true,
  opts: {
    ...kinds("pattern", ["-e", "--regexp"]),
    ...kinds("file", ["-f", "--file"]),
    ...kinds("glob", ["--include"]),
    ...kinds("skip", ["-A", "-B", "-C", "-m", "-d", "-D", "--exclude", "--exclude-dir"]),
    ...kinds("skip", ["--context", "--after-context", "--before-context", "--max-count"]),
    ...kinds("skip", ["--label", "--binary-files", "--devices", "--directories"]),
  },
};
/** @type {ArgSpec} */
const RG = {
  patternFirst: true,
  dirs: true,
  opts: {
    ...kinds("pattern", ["-e", "--regexp"]),
    ...kinds("file", ["-f", "--file"]),
    ...kinds("glob", ["-g", "--glob", "--iglob"]),
    ...kinds("skip", ["-A", "-B", "-C", "-m", "-t", "-T", "-r", "-E", "-M", "-j", "-d"]),
    ...kinds("skip", ["--type", "--type-not", "--type-add", "--type-clear", "--replace"]),
    ...kinds("skip", ["--context", "--after-context", "--before-context", "--max-count"]),
    ...kinds("skip", ["--encoding", "--engine", "--sort", "--sortr", "--color", "--colors"]),
    ...kinds("skip", ["--max-columns", "--threads", "--max-depth", "--max-filesize", "--pre"]),
    ...kinds("skip", ["--pre-glob", "--path-separator", "--context-separator"]),
  },
};
/** @type {ArgSpec} */
const AG = {
  patternFirst: true,
  dirs: true,
  opts: kinds("skip", ["-A", "-B", "-C", "-m", "-G", "-g", "--ignore", "--ignore-dir", "--depth"]),
};
/** @type {ArgSpec} */
const SED = {
  patternFirst: true,
  opts: {
    ...kinds("pattern", ["-e", "--expression"]),
    ...kinds("file", ["-f", "--file"]),
    ...kinds("skip", ["-l", "--line-length"]),
    ...kinds("glued", ["-i", "-I"]), // `sed -i.bak`, and GNU reads `-ie` as suffix `e`
  },
};
/** @type {ArgSpec} */
const AWK = {
  patternFirst: true,
  opts: {
    ...kinds("pattern", ["-e", "--source"]),
    ...kinds("file", ["-f", "--file"]),
    ...kinds("skip", ["-v", "-F", "--assign", "--field-separator"]),
  },
};
/** @type {ArgSpec} */
const JQ = {
  patternFirst: true,
  opts: {
    ...kinds("file", ["-f", "--from-file"]),
    ...kinds("skip", ["--indent", "-L"]),
    ...kinds("skip2", ["--arg", "--argjson"]),
    ...kinds("file2", ["--slurpfile", "--rawfile"]),
  },
};
/** Plain readers and writers (cat, head, sort, cp, …): every non-flag word is checked. */
/** @type {ArgSpec} */
const PLAIN = {
  strict: true,
  opts: kinds("value", ["-n", "-c", "--lines", "--bytes", "-k", "-t", "-S", "-T", "-w", "-d"]),
};

/** Commands that print file content → how to find their file operands.
 *  @type {Record<string, ArgSpec>} */
const READERS = {
  ...Object.fromEntries(
    [
      ...["cat", "tac", "nl", "head", "tail", "less", "more", "most", "bat", "batcat"],
      ...["xxd", "od", "hexdump", "strings", "base64", "sort", "uniq", "cut", "paste"],
      ...["fold", "rev", "diff", "cmp", "dd"],
    ].map((n) => [n, PLAIN]),
  ),
  ...Object.fromEntries(["grep", "egrep", "fgrep"].map((n) => [n, GREP])),
  rg: RG,
  ag: AG,
  ack: AG,
  sed: SED,
  ...Object.fromEntries(["awk", "gawk", "mawk", "nawk"].map((n) => [n, AWK])),
  jq: JQ,
  yq: JQ,
};
/** git subcommands that print file or history content (RA-05, HI-07). */
const GIT_READERS = new Set([
  ...["show", "log", "diff", "stash", "cat-file", "archive", "grep", "blame", "annotate"],
  ...["show-index", "bundle", "whatchanged"],
]);
/** show/log/diff print the content of every file under a directory pathspec, like grep -r. */
/** @type {ArgSpec} */
const GIT_LOG = {
  dirs: true,
  opts: {
    ...kinds("value", ["-L"]), // `-L1,5:.env` / `-L :fn:.env` read that file's history
    ...kinds("skip", ["--grep", "--author", "--committer", "--format", "--pretty", "-S", "-G"]),
    ...kinds("skip", ["-n", "--max-count", "--skip", "--since", "--until", "--date", "-U"]),
  },
};
/** @type {ArgSpec} */
const GIT_GREP = {
  patternFirst: true,
  dirs: true,
  opts: {
    ...kinds("pattern", ["-e"]),
    ...kinds("file", ["-f"]),
    ...kinds("skip", ["-A", "-B", "-C", "-m", "-O", "--max-depth", "--threads"]),
  },
};
/** git's global options that take a value (`git -C dir show …`). */
const GIT_GLOBAL_VALUES = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
/** Commands that WRITE to their file operands (HI-06). */
const WRITERS = new Set(["tee", "cp", "mv", "install", "ln", "truncate"]);

/**
 * A word's candidate paths: itself, the value of `key=path` (`dd of=`), the path of `REV:path`
 * (`git show HEAD:.env`, the index forms `:.env` and `:0:.env`) and of `@file`
 * (`curl -d @file`).
 * @param {string} t
 */
function pathCandidates(t) {
  const out = [t];
  const eq = /^[A-Za-z_][\w.-]*=([\s\S]*)$/.exec(t);
  if (eq) out.push(eq[1]);
  const colon = t.indexOf(":");
  if (colon >= 0 && !/^[A-Za-z]:[\\/]/.test(t)) {
    out.push(t.slice(colon + 1));
    const last = t.lastIndexOf(":");
    if (last !== colon) out.push(t.slice(last + 1));
  }
  if (t.startsWith("@")) out.push(t.slice(1));
  return out;
}

/**
 * The file operands among a command's arguments, under `spec`.
 * @param {Word[]} args
 * @param {ArgSpec} spec
 * @returns {{word: Word, glob?: boolean}[]}
 */
function operands(args, spec) {
  const opts = spec.opts ?? {};
  /** @type {{word: Word, glob?: boolean}[]} */
  const out = [];
  /** @type {Word[]} */
  const positional = [];
  let patternGiven = false;
  let endOfOpts = false;
  /** @param {string} kind @param {Word} word */
  const value = (kind, word) => {
    if (kind === "file" || kind === "pattern") patternGiven = true;
    if (kind === "glob") out.push({ word, glob: true });
    else if (kind === "file" || kind === "file2" || kind === "value") out.push({ word });
  };
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    const t = w.text;
    if (endOfOpts || t.length < 2 || !t.startsWith("-")) {
      positional.push(w);
      continue;
    }
    if (t === "--") {
      endOfOpts = true;
      continue;
    }
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const kind = opts[eq > 0 ? t.slice(0, eq) : t] ?? (spec.strict && eq > 0 ? "value" : "");
      if (!kind) continue;
      if (eq > 0) value(kind, { ...w, text: t.slice(eq + 1) });
      else if (kind === "skip2" || kind === "file2") {
        if (kind === "file2" && args[i + 2]) value(kind, args[i + 2]);
        i += 2;
      } else if (args[i + 1]) value(kind, args[++i]);
      continue;
    }
    for (let j = 1; j < t.length; j++) {
      const kind = opts[`-${t[j]}`];
      if (!kind) continue; // a flag letter
      if (kind === "glued") break;
      const rest = t.slice(j + 1);
      if (rest) value(kind, { ...w, text: rest });
      else if (args[i + 1]) value(kind, args[++i]);
      break;
    }
  }
  if (spec.patternFirst && !patternGiven) positional.shift();
  return [...out, ...positional.map((word) => ({ word }))];
}

/**
 * @param {Word} word
 * @param {PathCtx} ctx
 * @param {boolean} [asGlob]
 */
function isSecretWord(word, ctx, asGlob = false) {
  // `cat .{env,x}` is `cat .env .x`; an expansion too large to trust fails closed.
  const texts = word.brace ? expandBraces(word.text) : [word.text];
  if (texts.length >= BRACE_LIMIT) return true;
  texts.push(...(word.subst ?? []));
  return texts.some((t) =>
    pathCandidates(t).some(
      (c) => secretKind(c, ctx) !== null || ((asGlob || word.glob) && globMatchesSecret(c, ctx)),
    ),
  );
}

/**
 * The command string of `sh -c STRING` (`bash -lc …`, `bash -o pipefail -c …`), or null.
 * @param {Word[]} args
 */
function shellCommandString(args) {
  let c = false;
  for (let i = 0; i < args.length; i++) {
    const t = args[i].text;
    if (t.startsWith("--")) continue; // `--norc`, `--login`, `--`
    if (/^[-+][A-Za-z]+$/.test(t)) {
      if (t[0] === "-" && t.includes("c")) c = true;
      if (/[oO]$/.test(t)) i++; // `-o pipefail`, `-euo pipefail`, `-O extglob`
      continue;
    }
    return c ? t : null;
  }
  return null;
}

/** `sh -c` / `eval` nesting deeper than this is not unpicked: it fails closed. */
const MAX_NEST = 8;

const READ_REASON =
  "reading a protected secret path via Bash is blocked. Read it yourself if intended.";
const REDIRECT_REASON =
  "reading a protected secret path via input redirection is blocked. Read it yourself if intended.";
const WRITE_REASON =
  "writing to a protected secret path via Bash is blocked. Edit it yourself if intended.";
const NEST_REASON = `a command nested more than ${MAX_NEST} levels deep in sh -c / eval cannot be checked — blocking to fail closed.`;

/**
 * The reason a Bash command reads or writes a protected secret path (P0-04, HI-06), or null.
 * Checked per simple command: redirection targets, a writer's operands and a reader's FILE
 * operands, never a grep pattern, a commit message or a `--grep=` value. The string of
 * `bash -c …` and `eval …` is checked as a command line of its own.
 * @param {string} cmd
 * @param {PathCtx} [fsCtx]
 * @param {number} [depth] `sh -c` / `eval` nesting, for the fail-closed bound
 * @returns {string | null}
 */
export function secretShellAccess(cmd, fsCtx = {}, depth = 0) {
  if (depth > MAX_NEST) return NEST_REASON;
  const segments = shellSegments(String(cmd));
  // `cd ~ && cat .npmrc`: once the command changes directory, a relative path no longer
  // resolves against the payload cwd, so `.npmrc` is judged without it (fail closed).
  const moved = segments.some(({ words }) => {
    const c = commandOf(words);
    return c !== null && (CHDIR.has(c.name) || c.chdir);
  });
  /** @type {PathCtx} */
  const ctx = { ...fsCtx, bash: true, cwdUnknown: moved || Boolean(fsCtx.cwdUnknown) };
  /** @param {{word: Word, glob?: boolean}[]} ops @param {ArgSpec} [spec] */
  const anySecret = (ops, spec) =>
    ops.some((o) => isSecretWord(o.word, spec?.dirs ? { ...ctx, dir: true } : ctx, o.glob));
  for (const { words, redirs } of segments) {
    for (const { op, target } of redirs) {
      const fd = op.endsWith("&") && /^(\d+-?|-)$/.test(target.text); // `2>&1`: no file
      if (op === "<<<" || fd || !isSecretWord(target, ctx)) continue;
      return op.startsWith(">") ? WRITE_REASON : REDIRECT_REASON;
    }
    const c = commandOf(words);
    if (!c) continue;
    const { name, args } = c;
    const nested =
      name === "eval"
        ? args.map((a) => a.text).join(" ")
        : SHELLS.has(name)
          ? shellCommandString(args)
          : null;
    if (nested) {
      const inner = secretShellAccess(nested, { ...fsCtx, cwdUnknown: ctx.cwdUnknown }, depth + 1);
      if (inner) return inner;
    }
    if (WRITERS.has(name) && anySecret(operands(args, PLAIN))) return WRITE_REASON;
    const inPlace = args.some((a) => /^-[A-Za-z]*i|^--in-place/.test(a.text));
    if (name === "sed" && inPlace && anySecret(operands(args, SED))) return WRITE_REASON;
    const target = args.find((a) => a.text.startsWith("of="));
    if (name === "dd" && target && isSecretWord({ ...target, text: target.text.slice(3) }, ctx))
      return WRITE_REASON;
    const spec = READERS[name];
    if (spec && anySecret(operands(args, spec), spec)) return READ_REASON;
    if (name === "git") {
      let i = 0;
      while (i < args.length && args[i].text.startsWith("-"))
        i += GIT_GLOBAL_VALUES.has(args[i].text) ? 2 : 1;
      const sub = args[i]?.text ?? "";
      const gitSpec = sub === "grep" ? GIT_GREP : GIT_LOG;
      if (GIT_READERS.has(sub) && anySecret(operands(args.slice(i + 1), gitSpec), gitSpec))
        return READ_REASON;
    }
  }
  return null;
}

// ── Destructive-command rules. A command word starts at the line start, after a separator, or
// after whitespace (so `sudo rm`, `env rm` and `/bin/rm` are all caught).
const B = "(^|[^A-Za-z0-9_.-])([^\\s;&|]*/)?";
const SEG = "([^;&|]*\\s)?"; // further args inside the SAME command segment
const END = "(?=\\s|$|[;&|)])";
// An absolute/home path operand, or the working tree itself: `.`, `..`, `./`, `./*`, `*`.
const TARGET = `["']?(/|~|\\$HOME|\\$\\{HOME\\}|(\\.\\.?/?\\*?|\\*)["']?${END})`;
const RECUR = "(-[A-Za-z]*[rR][A-Za-z]*|--recursive)";
// git behind an optional `env `/`command `/`VAR=val ` prefix, an absolute path, and git's own
// global options (HI-07).
const gitpfx = "([A-Za-z0-9_]+=\\S+\\s+|(env|command|sudo)\\s+)*(\\S*/)?git\\s+";
const gitopt =
  "(-C\\s+\\S+\\s+|--no-pager\\s+|-c\\s+\\S+\\s+|--git-dir=\\S+\\s+|--work-tree=\\S+\\s+)*";
// A pathspec naming the whole tree.
const ALL_PATHS = `["']?(\\.|\\./|:/|\\*)["']?${END}`;
/** A flag (`--long` or a short letter, possibly grouped) somewhere in the same segment.
 *  @param {string} long @param {string} short */
const flagIn = (long, short) =>
  `(?:[^;&|]*\\s)?(?:--${long}|-[A-Za-z]*${short}[A-Za-z]*)(?:\\s|$|[;&|])`;
// `git restore --staged .` only unstages; the working tree is untouched, so it stays allowed.
const STAGED_ONLY = `(?=${flagIn("staged", "S")})(?!${flagIn("worktree", "W")})`;
// The far end of a pipe, behind `sudo`/`doas`/`env`/`command` wrappers.
const PIPED =
  "\\|&?\\s*((sudo|doas)(\\s+(-[ugCDhprtUT]\\s+\\S+|-\\S+))*\\s+|env(\\s+-\\S+)*(\\s+[A-Za-z_]\\w*=\\S*)*\\s+|(command|exec|nohup)\\s+)*(\\S*/)?";

/** @type {{all: RegExp[], reason: string}[]} — first match wins. */
const COMMAND_RULES = [
  {
    // Recursive delete of an absolute/home path or the whole working tree, flags in any order.
    all: [
      new RegExp(
        `${B}rm\\s+${SEG}${RECUR}(\\s[^;&|]*)?\\s${TARGET}|${B}rm\\s+${SEG}${TARGET}[^;&|]*\\s${RECUR}(\\s|$)|${B}rm\\s+${SEG}--no-preserve-root`,
      ),
    ],
    reason:
      "destructive rm (recursive delete of an absolute/home path or the working tree) detected.",
  },
  {
    // `--force-with-lease` / `--force-if-includes` are the SAFE variants and stay allowed.
    all: [
      new RegExp(
        `${gitpfx}${gitopt}push\\s${SEG}(--force([\\s=]|$)|-[A-Za-z0-9]*f[A-Za-z0-9]*(\\s|$)|\\+\\S+(\\s|$))`,
      ),
    ],
    reason: "force-push blocked (--force-with-lease is allowed). Ask the user first.",
  },
  {
    all: [new RegExp(`${gitpfx}${gitopt}reset\\s${SEG}--hard(\\s|$)`)],
    reason: "`git reset --hard` discards uncommitted work. Ask the user first.",
  },
  {
    // The same data loss as `reset --hard`, spelled as a whole-tree checkout or restore.
    all: [
      new RegExp(
        `${gitpfx}${gitopt}(checkout\\s${SEG}${ALL_PATHS}|restore\\s(?!${STAGED_ONLY})${SEG}${ALL_PATHS})`,
      ),
    ],
    reason:
      "`git checkout .` / `git restore .` discard every uncommitted change. Ask the user first.",
  },
  {
    all: [
      new RegExp(`${gitpfx}${gitopt}clean\\s${SEG}(-[A-Za-z0-9]*f[A-Za-z0-9]*|--force)(\\s|$)`),
    ],
    reason: "`git clean -f` deletes untracked files for good. Ask the user first.",
  },
  {
    all: [new RegExp(`${B}find\\s[^;&|]*\\s(-delete|-exec\\s+(\\S*/)?rm)(\\s|$)`)],
    reason: "`find … -delete` / `-exec rm` detected. Ask the user first.",
  },
  {
    all: [new RegExp(`${B}chmod\\s+${SEG}(-[A-Za-z]*R[A-Za-z]*|--recursive)(\\s|$)`)],
    reason: "recursive chmod detected. Ask the user first.",
  },
  {
    all: [new RegExp(`${B}dd\\s+${SEG}of=`)],
    reason: "`dd … of=` overwrites its target. Ask the user first.",
  },
  {
    // Case-insensitive for the SQL keywords; the bare `TRUNCATE <table>` form stays
    // uppercase-only so the coreutils `truncate` command is not a false positive.
    all: [/\bdrop\s+(table|database|schema)\b|\btruncate\s+table\b|TRUNCATE\s+[A-Za-z0-9_"]/i],
    reason: "destructive SQL detected. Confirm with the user.",
  },
  {
    // Pipe-to-shell (`curl … | sh`, `| sudo bash`), or to an interpreter that runs its stdin as
    // the program (`| python3`, `| node -`). Boundary-aware, so `… | shellcheck` and
    // `… | python3 -m json.tool` are not caught.
    all: [
      new RegExp(
        `${PIPED}((sh|bash|zsh|dash|ksh|mksh|fish)(\\s|$|[;&|)])|(python[0-9.]*|node|nodejs|perl|ruby|php|deno|bun)(\\s+-)?\\s*($|[;&|)]))`,
      ),
    ],
    reason: "piping content to a shell is blocked.",
  },
];

/**
 * True iff a Grep tool filter keeps the search to source files: every alternative of its glob
 * ends in a code extension (`*.tsx`, `*.{ts,tsx}`), or, with no glob, its type names one (`ts`).
 * @param {string} glob
 * @param {string} type
 */
function codeOnlyFilter(glob, type) {
  if (glob) {
    const alts = expandBraces(glob);
    return alts.length < BRACE_LIMIT && alts.every((a) => !a.startsWith("!") && CODE_FILE.test(a));
  }
  return Boolean(type) && CODE_FILE.test(`x.${type}`);
}

/**
 * PURE decision over one tool call — the testable core. Its one filesystem touch is reading a
 * project `.npmrc` to see whether it holds a token (`readText`, injectable).
 * @param {{toolName?: string, filePath?: string, command?: string, glob?: string, type?: string} & FsCtx} [call]
 * @returns {{block: boolean, reason?: string}}
 */
export function protectPathsDecision({
  toolName = "",
  filePath = "",
  command = "",
  glob = "",
  type = "",
  ...fsCtx
} = {}) {
  // A plugin install carries no `permissions.deny` block, so for Read/Grep this guard is the
  // only thing between the agent and `.env`.
  const verb = /^(Read|Grep|Glob|NotebookRead)$/.test(String(toolName)) ? "read" : "modify";
  if (filePath) {
    // The Grep tool searches a directory recursively, so a `secrets` store itself is protected —
    // unless its glob/type keeps the search to source files (a Next.js `app/…/secrets/` route).
    const dir = toolName === "Grep" && !codeOnlyFilter(String(glob), String(type));
    const what = secretKind(String(filePath), { ...fsCtx, dir });
    if (what)
      return {
        block: true,
        reason: `refusing to ${verb} ${what} (${filePath}). Handle it yourself if intended.`,
      };
  }
  // A literal name (`.env`) or a wildcard that can select one; an exclusion (`!.env`) never does.
  const g = String(glob);
  if (g && !g.startsWith("!") && (secretKind(g, fsCtx) || globMatchesSecret(g, fsCtx)))
    return {
      block: true,
      reason: `refusing to ${verb} files matching ${glob}: it selects a protected secret path. Handle it yourself if intended.`,
    };
  const cmd = String(command);
  if (cmd) {
    const io = secretShellAccess(cmd, fsCtx);
    if (io) return { block: true, reason: io };
    for (const rule of COMMAND_RULES) {
      if (rule.all.every((re) => re.test(cmd))) return { block: true, reason: rule.reason };
    }
  }
  return { block: false };
}

/** @param {string} reason */
function deny(reason) {
  // Structured decision for current Claude Code; exit-2 + stderr is the version-agnostic
  // fallback that older versions (and `forge doctor`) rely on.
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.stderr.write(`BLOCKED by protect-paths guard: ${reason}\n`);
  process.exit(2);
}

async function main() {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  let data;
  try {
    data = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    deny("cannot parse the hook payload — blocking to fail closed");
    return;
  }
  const inp = data.tool_input ?? {};
  const d = protectPathsDecision({
    toolName: data.tool_name,
    filePath: inp.file_path ?? inp.notebook_path ?? inp.path ?? "",
    command: inp.command ?? "",
    // The Grep tool's `glob`/`type` filters select the files it reads; Glob only lists names.
    glob: data.tool_name === "Grep" ? (inp.glob ?? "") : "",
    type: data.tool_name === "Grep" ? (inp.type ?? "") : "",
    cwd: typeof data.cwd === "string" && data.cwd ? data.cwd : process.cwd(),
  });
  if (d.block) deny(String(d.reason));
}

// Run only as the hook entrypoint; importing it (tests) must evaluate no payload.
if (process.argv[1] && /protect-paths\.mjs$/i.test(process.argv[1])) {
  main().catch((err) => deny(`internal error (${err?.message ?? err}) — blocking to fail closed`));
}
