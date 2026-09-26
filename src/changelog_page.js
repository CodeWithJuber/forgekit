// The docs site's changelog page, generated from CHANGELOG.md so the two cannot drift. The
// page used to be written by hand and stopped at one July entry while thirty releases
// shipped. Now every release — and the [Unreleased] work on the default branch — becomes one
// Mintlify <Update> entry listing the headline of each change (the bold lead sentence the
// CHANGELOG convention puts first; the first sentence when there is none), with a link to
// that release's full notes. `forge docs render` splices it into the page between MDX-safe
// markers, `forge docs check` fails when the page is stale, and scripts/bump.mjs
// regenerates it in the release commit. Pure text → text, node stdlib only.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The page the entries are spliced into (relative to the repo root). */
export const CHANGELOG_PAGE = "mintlify/changelog/overview.mdx";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "2026-09-24" → "September 24, 2026" (no locale dependency); anything else unchanged. */
export function longDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return String(iso ?? "");
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

/** GitHub's heading anchor: lowercase, punctuation dropped, each space a hyphen. */
export function githubSlug(heading) {
  return String(heading)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/**
 * Parse Keep-a-Changelog text into releases, newest first. Each section keeps the first
 * paragraph of each top-level bullet (joined onto one line); nested lists, later paragraphs,
 * prose between bullets and fenced code are not headlines and are skipped. Repeated section
 * headings within one release merge.
 * @param {string} text
 * @returns {{version: string, date: string|null, heading: string,
 *   sections: {label: string, bullets: string[]}[]}[]}
 */
export function parseChangelog(text) {
  /** @type {ReturnType<typeof parseChangelog>} */
  const releases = [];
  /** @type {ReturnType<typeof parseChangelog>[number] | null} */
  let release = null;
  /** @type {{label: string, bullets: string[]} | null} */
  let section = null;
  /** @type {string[] | null} */
  let bullet = null;
  let fenced = false;
  const flush = () => {
    if (bullet && section) section.bullets.push(bullet.join(" "));
    bullet = null;
  };
  const sectionFor = (label) => {
    if (!release) return null;
    let s = release.sections.find((x) => x.label === label);
    if (!s) {
      s = { label, bullets: [] };
      release.sections.push(s);
    }
    return s;
  };
  for (const line of String(text ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const h2 = /^## \[([^\]]+)\](?:\s+-\s+(\S+))?/.exec(line);
    if (h2) {
      flush();
      release = {
        version: h2[1],
        date: h2[2] ?? null,
        heading: line.slice(3).trim(),
        sections: [],
      };
      releases.push(release);
      section = null;
      continue;
    }
    if (!release) continue;
    if (/^\[[^\]]+\]:\s/.test(line)) {
      // The compare-link references at the bottom end the last release.
      flush();
      release = null;
      continue;
    }
    const h3 = /^###\s+(.+?)\s*$/.exec(line);
    if (h3) {
      flush();
      section = sectionFor(h3[1]);
      continue;
    }
    if (line.startsWith("- ")) {
      flush();
      section ??= sectionFor("Changes");
      bullet = [line.slice(2).trim()];
      continue;
    }
    if (bullet && /^\s+\S/.test(line) && !/^\s+(?:[-*+]|\d+\.)\s/.test(line)) {
      bullet.push(line.trim());
      continue;
    }
    flush();
  }
  flush();
  return releases;
}

/** Cut `s` to at most `max` characters at a word boundary, never inside a code span. */
function clip(s, max) {
  if (s.length <= max) return s;
  let cut = s.lastIndexOf(" ", max);
  if (cut < max / 2) cut = max;
  let out = s.slice(0, cut);
  if ((out.match(/`/g) ?? []).length % 2) out = out.slice(0, out.lastIndexOf("`")).trimEnd();
  return `${out} …`;
}

/**
 * The headline of one bullet: its bold lead, or else its first sentence (outside code
 * spans, not at "e.g."/"i.e."), clipped to `max` characters.
 * @param {string} bullet the bullet's first paragraph, on one line
 * @param {{max?: number}} [opts]
 */
export function headline(bullet, { max = 280 } = {}) {
  const t = String(bullet).replace(/\s+/g, " ").trim();
  const bold = /^\*\*(.+?)\*\*/.exec(t);
  // A lead that introduces a list ("…by default:") reads as a sentence without its colon.
  if (bold) return `**${bold[1].trim().replace(/\s*[:;,]$/, "")}**`;
  let code = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "`") code = !code;
    else if (
      !code &&
      (c === "." || c === "!" || c === "?") &&
      (i + 1 === t.length || t[i + 1] === " ") &&
      !/\b(?:e\.g|i\.e|etc|vs|approx)$/i.test(t.slice(0, i))
    )
      return clip(t.slice(0, i + 1), max);
  }
  return clip(t.replace(/\s*[:;,]$/, ""), max);
}

const ESCAPES = { "<": "&lt;", ">": "&gt;", "{": "&#123;", "}": "&#125;" };

/**
 * Markdown → MDX-safe markdown for one line: outside code spans, `<` `>` `{` `}` become
 * character references (MDX would read them as JSX or expressions); autolinks become links;
 * relative links point at the file on GitHub, so the site never links into its own tree.
 * @param {string} s
 * @param {string} repo repository web URL, e.g. https://github.com/owner/name
 */
export function mdxInline(s, repo) {
  return String(s)
    .split(/(`[^`]*`)/)
    .map((part, i) => {
      if (i % 2) return part; // a code span is literal in MDX
      return part
        .replace(/<(https?:\/\/[^>\s]+)>/g, "[$1]($1)")
        .replace(/\]\(([^)\s]+)\)/g, (_, href) => {
          if (/^(?:https?:|mailto:)/i.test(href)) return `](${href})`;
          if (href.startsWith("#")) return `](${repo}/blob/HEAD/CHANGELOG.md${href})`;
          return `](${repo}/blob/HEAD/${href.replace(/^\.?\//, "")})`;
        })
        .replace(/[<>{}]/g, (c) => ESCAPES[/** @type {"<"|">"|"{"|"}"} */ (c)]);
    })
    .join("");
}

/** The filter tag of a section heading: "Fixed (audit remediation)" → "Fixed". */
const tagOf = (label) => {
  const w = /^[A-Za-z]+/.exec(label)?.[0] ?? "Changes";
  return w[0].toUpperCase() + w.slice(1).toLowerCase();
};

/**
 * Every release as a Mintlify <Update> entry, newest first.
 * @param {string} changelog the CHANGELOG.md text
 * @param {{repo: string}} opts repository web URL (for the "full notes" links)
 * @returns {string}
 */
export function renderChangelogUpdates(changelog, { repo }) {
  const out = [];
  for (const r of parseChangelog(changelog)) {
    const sections = r.sections.filter((s) => s.bullets.length);
    if (!sections.length) continue;
    const unreleased = /^unreleased$/i.test(r.version);
    const label = unreleased ? "Unreleased" : `v${r.version}`;
    const description = unreleased
      ? "Merged on the default branch, not yet released"
      : longDate(r.date);
    const tags = [...new Set(sections.map((s) => tagOf(s.label)))];
    out.push(
      `<Update label="${label}" description="${description}" tags={${JSON.stringify(tags)}}>`,
      "",
    );
    for (const s of sections) {
      out.push(`**${mdxInline(s.label, repo)}**`, "");
      for (const b of s.bullets) out.push(`- ${mdxInline(headline(b), repo)}`);
      out.push("");
    }
    out.push(
      `[Full notes for ${label} →](${repo}/blob/HEAD/CHANGELOG.md#${githubSlug(r.heading)})`,
      "",
      "</Update>",
      "",
    );
  }
  return out.join("\n").trimEnd();
}

/** The repository's web URL from package.json `repository` (git+https / .git stripped). */
export function repoUrl(root) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    return String(url ?? "")
      .replace(/^git\+/, "")
      .replace(/\.git$/, "")
      .replace(/^git@github\.com:/, "https://github.com/");
  } catch {
    return "";
  }
}

/** The generated block for `root`'s CHANGELOG.md (what `forge docs render` splices in). */
export function renderChangelogPage(root) {
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  return renderChangelogUpdates(changelog, { repo: repoUrl(root) });
}
