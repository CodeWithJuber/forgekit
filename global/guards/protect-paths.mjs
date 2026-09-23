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
// SCOPE: pattern matching, not a sandbox. A word splitter cannot evaluate shell, so indirection
// (`f=.env; cat $f`, brace expansion, `find … -exec cat {}`) and interpreter-driven access
// (`python -c 'open(".env")…'`, `node -e …`) are DELIBERATELY out of scope. This layer sits
// behind the permission system and secret-redact.sh: best-effort hardening, never a boundary.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * @typedef {{cwd?: string, home?: string, readText?: (absPath: string) => string | null}} FsCtx
 * @typedef {FsCtx & {bash?: boolean}} PathCtx
 * @typedef {{text: string, glob: boolean, quoted: boolean}} Word
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
  const env = /^\.env((?:\.[\w-]+)*)~?$/i.exec(base);
  if (env) {
    if (!ENV_TEMPLATE.has(env[1].split(".").pop()?.toLowerCase() ?? "")) return "env file";
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
 * cannot resolve (`$DIR/.npmrc`): fail closed.
 * @param {string} p forward-slashed path
 * @param {FsCtx} ctx
 */
function npmrcIsSecret(p, ctx) {
  if (/^~[^/]*\//.test(p) || /^\$\{?HOME\}?\//.test(p)) return true;
  if (/[$`]/.test(p)) return true;
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

/**
 * True iff the wildcard pattern `glob` (a shell glob, an `rg -g` glob, the Grep tool's `glob`)
 * can select a protected secret file by name.
 * @param {string} glob
 */
export function globMatchesSecret(glob) {
  const g = slashes(glob);
  if (g.startsWith("!")) return false; // an exclusion (`rg -g '!.env'`) never selects a file
  const base = g.split("/").pop() ?? "";
  if (!/[*?[]/.test(base)) return false; // no wildcard in the name: the literal check covers it
  let re;
  try {
    re = globRegExp(base);
  } catch {
    return true; // an unparsable class: fail closed
  }
  const dotted = base.startsWith(".");
  const literal = base.replace(/\[[^\]]*\]|[*?.]/g, "");
  return GLOB_SAMPLES.some((s) => (s.startsWith(".") ? dotted : literal.length > 0) && re.test(s));
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
 * skipped as data unless it is fed to a shell.
 * @param {string} cmd
 * @returns {Segment[]}
 */
export function shellSegments(cmd) {
  /** @type {Segment[]} */
  const done = [];
  /** @returns {{words: Word[], redirs: Redirect[], cur: Word | null, redir: string | null}} */
  const fresh = () => ({ words: [], redirs: [], cur: null, redir: null });
  let ctx = fresh();
  /** @type {{ctx: ReturnType<typeof fresh>, kind: string, dq: boolean}[]} */
  const stack = [];
  let dq = false; // inside "…"
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
      const first = ctx.words.find((x) => !/^[A-Za-z_]\w*=/.test(x.text));
      heredocs.push({
        delim: w.text,
        strip: op === "<<-",
        exec: SHELLS.has(cmdName(first?.text ?? "")),
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
    stack.push({ ctx, kind, dq });
    ctx = fresh();
    dq = false;
  };
  const close = () => {
    endSeg();
    const f = /** @type {(typeof stack)[number]} */ (stack.pop());
    ctx = f.ctx;
    dq = f.dq;
    if (f.kind !== "(") add("$()"); // an expansion inside a word: no longer a literal path
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
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    const next = cmd[i + 1];
    if (dq) {
      if (c === '"') dq = false;
      else if (c === "\\" && next !== undefined && '"\\$`\n'.includes(next)) {
        if (next !== "\n") add(next, false, true);
        i++;
      } else if (c === "$" && next === "(") {
        open("$(");
        i++;
      } else if (c === "`") open("`");
      else add(c, false, true);
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
    } else if (c === "$" && next === "(") {
      open("$(");
      i++;
    } else if (c === "`") {
      if (stack.at(-1)?.kind === "`") close();
      else open("`");
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
    } else add(c, c === "*" || c === "?" || c === "[");
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
  sudo: ["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T", "--user", "--group"],
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

/**
 * The command a segment runs, past `VAR=val` prefixes, keywords and wrappers.
 * @param {Word[]} words
 * @returns {{name: string, args: Word[]} | null}
 */
function commandOf(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    // `FOO="a b" cat .env`: an assignment even when its value is quoted.
    if (/^[A-Za-z_]\w*(\[[^\]]*\])?\+?=/.test(w.text) || KEYWORDS.has(w.text)) {
      i++;
      continue;
    }
    const name = cmdName(w.text);
    const values = WRAPPERS[name];
    if (!values) return { name, args: words.slice(i + 1) };
    let positional = name === "timeout" ? 1 : 0; // timeout DURATION cmd…
    for (i++; i < words.length; ) {
      const a = words[i].text;
      if (a === "--") {
        i++;
        break;
      }
      if (a.length > 1 && a.startsWith("-")) i += values.includes(a) ? 2 : 1;
      else if (positional-- > 0) i++;
      else break;
    }
  }
  return null;
}

/**
 * How a command's arguments map to files. `patternFirst`: its first operand is a pattern or a
 * program (grep, sed, awk, jq), not a file. `opts` names the options that take a value:
 *   file    — a path (checked); it also supplies the pattern/program (`grep -f`, `sed -f`)
 *   pattern — a pattern or program, not a path; it supplies the pattern (`grep -e`, `sed -e`)
 *   glob    — a file glob, checked as one (`rg -g`, `grep --include`)
 *   skip    — any other non-path value (`git log --grep`, `rg -t`, `head -n`)
 *   skip2 / file2 — two-word options (`jq --arg k v` / `jq --rawfile k FILE`)
 * Any option not listed is a flag (or a glued `-Xvalue`).
 * @typedef {{patternFirst?: boolean, opts?: Record<string, string>}} ArgSpec
 */
/** @param {string} kind @param {string[]} names */
const kinds = (kind, names) => Object.fromEntries(names.map((n) => [n, kind]));

/** @type {ArgSpec} */
const GREP = {
  patternFirst: true,
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
  opts: kinds("skip", ["-A", "-B", "-C", "-m", "-G", "-g", "--ignore", "--ignore-dir", "--depth"]),
};
/** @type {ArgSpec} */
const SED = {
  patternFirst: true,
  opts: {
    ...kinds("pattern", ["-e", "--expression"]),
    ...kinds("file", ["-f", "--file"]),
    ...kinds("skip", ["-l", "--line-length"]),
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
/** @type {ArgSpec} */
const PLAIN = {
  opts: kinds("skip", ["-n", "-c", "--lines", "--bytes", "-k", "-t", "-S", "-T", "-w", "-d"]),
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
/** @type {ArgSpec} */
const GIT_LOG = {
  opts: {
    ...kinds("skip", ["--grep", "--author", "--committer", "--format", "--pretty", "-S", "-G"]),
    ...kinds("skip", ["-n", "--max-count", "--skip", "--since", "--until", "--date", "-U"]),
  },
};
/** @type {ArgSpec} */
const GIT_GREP = {
  patternFirst: true,
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
 * (`git show HEAD:.env`) and of `@file` (`curl -d @file`).
 * @param {string} t
 */
function pathCandidates(t) {
  const out = [t];
  const eq = /^[A-Za-z_][\w.-]*=([\s\S]*)$/.exec(t);
  if (eq) out.push(eq[1]);
  const colon = t.indexOf(":");
  if (colon > 0 && !/^[A-Za-z]:[\\/]/.test(t)) out.push(t.slice(colon + 1));
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
    else if (kind === "file" || kind === "file2") out.push({ word });
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
    const eq = t.indexOf("=");
    const name = eq > 0 ? t.slice(0, eq) : t;
    const kind = opts[name];
    if (!kind) continue;
    if (eq > 0) value(kind, { ...w, text: t.slice(eq + 1) });
    else if (kind === "skip2" || kind === "file2") {
      if (kind === "file2" && args[i + 2]) value(kind, args[i + 2]);
      i += 2;
    } else if (args[i + 1]) value(kind, args[++i]);
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
  return pathCandidates(word.text).some(
    (c) => secretKind(c, ctx) !== null || ((asGlob || word.glob) && globMatchesSecret(c)),
  );
}

const READ_REASON =
  "reading a protected secret path via Bash is blocked. Read it yourself if intended.";
const REDIRECT_REASON =
  "reading a protected secret path via input redirection is blocked. Read it yourself if intended.";
const WRITE_REASON =
  "writing to a protected secret path via Bash is blocked. Edit it yourself if intended.";

/**
 * The reason a Bash command reads or writes a protected secret path (P0-04, HI-06), or null.
 * Checked per simple command: redirection targets, a writer's operands and a reader's FILE
 * operands, never a grep pattern, a commit message or a `--grep=` value.
 * @param {string} cmd
 * @param {FsCtx} [fsCtx]
 * @returns {string | null}
 */
export function secretShellAccess(cmd, fsCtx = {}) {
  /** @type {PathCtx} */
  const ctx = { ...fsCtx, bash: true };
  /** @param {{word: Word, glob?: boolean}[]} ops */
  const anySecret = (ops) => ops.some((o) => isSecretWord(o.word, ctx, o.glob));
  for (const { words, redirs } of shellSegments(String(cmd))) {
    for (const { op, target } of redirs) {
      const fd = op.endsWith("&") && /^(\d+-?|-)$/.test(target.text); // `2>&1`: no file
      if (op === "<<<" || fd || !isSecretWord(target, ctx)) continue;
      return op.startsWith(">") ? WRITE_REASON : REDIRECT_REASON;
    }
    const c = commandOf(words);
    if (!c) continue;
    const { name, args } = c;
    if (WRITERS.has(name) && anySecret(operands(args, PLAIN))) return WRITE_REASON;
    const inPlace = args.some((a) => /^-[A-Za-z]*i|^--in-place/.test(a.text));
    if (name === "sed" && inPlace && anySecret(operands(args, SED))) return WRITE_REASON;
    const target = args.find((a) => a.text.startsWith("of="));
    if (name === "dd" && target && isSecretWord({ ...target, text: target.text.slice(3) }, ctx))
      return WRITE_REASON;
    const spec = READERS[name];
    if (spec && anySecret(operands(args, spec))) return READ_REASON;
    if (name === "git") {
      let i = 0;
      while (i < args.length && args[i].text.startsWith("-"))
        i += GIT_GLOBAL_VALUES.has(args[i].text) ? 2 : 1;
      const sub = args[i]?.text ?? "";
      const rest = args.slice(i + 1);
      if (GIT_READERS.has(sub) && anySecret(operands(rest, sub === "grep" ? GIT_GREP : GIT_LOG)))
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
 * PURE decision over one tool call — the testable core. Its one filesystem touch is reading a
 * project `.npmrc` to see whether it holds a token (`readText`, injectable).
 * @param {{toolName?: string, filePath?: string, command?: string, glob?: string} & FsCtx} [call]
 * @returns {{block: boolean, reason?: string}}
 */
export function protectPathsDecision({
  toolName = "",
  filePath = "",
  command = "",
  glob = "",
  ...fsCtx
} = {}) {
  // A plugin install carries no `permissions.deny` block, so for Read/Grep this guard is the
  // only thing between the agent and `.env`.
  const verb = /^(Read|Grep|Glob|NotebookRead)$/.test(String(toolName)) ? "read" : "modify";
  if (filePath) {
    const what = secretKind(String(filePath), fsCtx);
    if (what)
      return {
        block: true,
        reason: `refusing to ${verb} ${what} (${filePath}). Handle it yourself if intended.`,
      };
  }
  // A literal name (`.env`) or a wildcard that can select one; an exclusion (`!.env`) never does.
  const g = String(glob);
  if (g && !g.startsWith("!") && (secretKind(g, fsCtx) || globMatchesSecret(g)))
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
    // The Grep tool's `glob` filter selects the files it reads; Glob only lists names.
    glob: data.tool_name === "Grep" ? (inp.glob ?? "") : "",
    cwd: typeof data.cwd === "string" && data.cwd ? data.cwd : process.cwd(),
  });
  if (d.block) deny(String(d.reason));
}

// Run only as the hook entrypoint; importing it (tests) must evaluate no payload.
if (process.argv[1] && /protect-paths\.mjs$/i.test(process.argv[1])) {
  main().catch((err) => deny(`internal error (${err?.message ?? err}) — blocking to fail closed`));
}
