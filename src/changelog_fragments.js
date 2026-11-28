// Changelog fragments — unreleased entries as one file per change, so parallel pull requests
// never edit the same lines.
//
// Every pull request used to add its line under CHANGELOG.md's `## [Unreleased]`, and the
// first one to merge put every other open one in conflict, at the same spot, every time
// (GitHub does not honour `merge=union` for pull requests). A repository that has a
// `changelog.d/` directory keeps its unreleased entries there instead: each change adds its
// own file, named after the branch or the change, holding one or more Keep a Changelog
// sections:
//
//   ### Added
//
//   - **`forge impact --record`** runs each test file …
//
// Nothing else touches CHANGELOG.md until a release, when the release script folds every
// fragment into the new version's section and deletes the files. Opt-in: a repository without
// `changelog.d/` keeps writing `[Unreleased]` by hand, as before.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const FRAGMENT_DIR = "changelog.d";
/** Keep a Changelog's sections, in its order. */
export const SECTIONS = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];

/**
 * The fragment files of a repository, sorted by name. `README.md` explains the directory and is
 * not a fragment. Null when the repository does not use fragments.
 * @param {string} root
 * @returns {{file: string, text: string}[] | null}
 */
export function readFragments(root) {
  let names;
  try {
    names = readdirSync(join(root, FRAGMENT_DIR));
  } catch {
    return null;
  }
  return names
    .filter((n) => n.endsWith(".md") && n.toLowerCase() !== "readme.md")
    .sort()
    .map((n) => ({
      file: `${FRAGMENT_DIR}/${n}`,
      text: readFileSync(join(root, FRAGMENT_DIR, n), "utf8").replace(/\r\n/g, "\n"),
    }));
}

/**
 * Split a Keep a Changelog body into its `### Section` blocks. Text before the first heading is
 * returned as `lead`.
 * @param {string} body
 * @returns {{lead: string, sections: Map<string, string>, unknown: string[]}}
 */
export function splitSections(body) {
  /** @type {Map<string, string>} */
  const sections = new Map();
  /** @type {string[]} */
  const unknown = [];
  const parts = String(body).split(/^### +(.+?)\s*$/m);
  const lead = (parts[0] ?? "").trim();
  for (let i = 1; i < parts.length; i += 2) {
    const raw = parts[i].trim();
    const name = SECTIONS.find((s) => s.toLowerCase() === raw.toLowerCase());
    const text = (parts[i + 1] ?? "").trim();
    if (!name) {
      unknown.push(raw);
      continue;
    }
    if (text) sections.set(name, sections.has(name) ? `${sections.get(name)}\n${text}` : text);
  }
  return { lead, sections, unknown };
}

/**
 * What is wrong with each fragment: no recognised section, an unknown heading, text outside a
 * section, or a section with no entry.
 * @param {{file: string, text: string}[]} fragments
 * @returns {{file: string, detail: string}[]}
 */
export function fragmentErrors(fragments) {
  /** @type {{file: string, detail: string}[]} */
  const out = [];
  for (const { file, text } of fragments) {
    const { lead, sections, unknown } = splitSections(text);
    if (unknown.length)
      out.push({ file, detail: `unknown section "${unknown[0]}" (use ${SECTIONS.join(", ")})` });
    if (lead)
      out.push({ file, detail: "text before the first `### Section` heading — put it under one" });
    if (!sections.size && !unknown.length)
      out.push({
        file,
        detail: `no entry: start with a heading such as "### Added", then a bullet`,
      });
  }
  return out;
}

/**
 * The `[Unreleased]` body with every fragment folded in: each section keeps its existing
 * entries first, then the fragments' in file-name order; sections follow Keep a Changelog's
 * order. Pure.
 * @param {string} unreleased the current `[Unreleased]` body (often empty)
 * @param {{file: string, text: string}[]} fragments
 */
export function foldFragments(unreleased, fragments) {
  const base = splitSections(unreleased ?? "");
  /** @type {Map<string, string[]>} */
  const merged = new Map(SECTIONS.map((s) => [s, []]));
  for (const [name, text] of base.sections) merged.get(name)?.push(text);
  for (const { text } of fragments)
    for (const [name, entry] of splitSections(text).sections) merged.get(name)?.push(entry);
  const blocks = SECTIONS.filter((s) => merged.get(s)?.length).map(
    (s) => `### ${s}\n\n${/** @type {string[]} */ (merged.get(s)).join("\n")}`,
  );
  return [base.lead, ...blocks].filter(Boolean).join("\n\n");
}
