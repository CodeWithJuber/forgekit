// Process confinement for a command ForgeKit runs on the user's behalf, delegated to a sandbox
// runtime that is already installed. ForgeKit implements no sandbox of its own: writing one
// correctly means Seatbelt profiles on macOS, bubblewrap and seccomp on Linux and a filtered
// account on Windows, and Anthropic's Sandbox Runtime (`srt`, Apache-2.0) already does that
// work. This module only decides how to call it and reports what was actually enforced.
//
// The policy is fixed and small, because the command is a test run:
//   network   denied entirely (an empty allow-list)
//   writes    only the directories the caller names (the throwaway checkout)
//   reads     everything except the credential stores listed below
// `srt` needs Node >= 22.12, and on Linux `bwrap` and `socat`. When it is not installed the
// caller chooses: run unconfined and say so ("auto"), or refuse ("required").
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasBin } from "./util.js";

export const SANDBOX_MODES = ["auto", "required", "off"];

/** Credential stores a test run has no reason to read. `~` is expanded by the runtime. */
export const CREDENTIAL_PATHS = [
  "~/.ssh",
  "~/.aws",
  "~/.azure",
  "~/.gnupg",
  "~/.kube",
  "~/.docker",
  "~/.config/gh",
  "~/.config/gcloud",
  "~/.npmrc",
  "~/.netrc",
  "~/.pypirc",
  "~/.git-credentials",
];

/**
 * The settings file handed to the runtime.
 * @param {{writable: string[]}} opts absolute directories the command may write to
 */
export function sandboxSettings({ writable }) {
  return {
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: {
      denyRead: [...CREDENTIAL_PATHS],
      allowRead: [],
      allowWrite: [...writable],
      denyWrite: [],
    },
  };
}

/** What the caller can truthfully say about a run that was not confined. */
const UNCONFINED = Object.freeze({
  process: "none",
  network: "host",
  writes: "host",
  credentials: "readable",
});

/**
 * Wrap a command for confined execution.
 *
 * Returns the command to spawn, a description of the isolation that will apply, and a cleanup
 * function for the temporary settings file. With mode "required" and no runtime installed it
 * returns `{ error }` instead: the caller must not run the command.
 * @param {string} command
 * @param {string[]} args
 * @param {{mode?: string, writable: string[], find?: (bin: string) => boolean}} opts
 * @returns {{command: string, args: string[], isolation: Record<string, any>, cleanup: () => void}
 *           | {error: string}}
 */
export function wrapCommand(command, args, { mode = "auto", writable, find = hasBin }) {
  if (!SANDBOX_MODES.includes(mode))
    return { error: `sandbox mode must be one of: ${SANDBOX_MODES.join(", ")}` };
  const plain = (why) => ({
    command,
    args,
    isolation: { ...UNCONFINED, reason: why },
    cleanup: () => {},
  });
  if (mode === "off") return plain("sandbox switched off");
  if (!find("srt")) {
    if (mode === "required")
      return {
        error:
          "no sandbox runtime found: install it with `npm install -g @anthropic-ai/sandbox-runtime` (Linux also needs bubblewrap and socat), or drop --sandbox required",
      };
    return plain("no sandbox runtime installed");
  }
  // A private directory, so another local user cannot swap the policy before it is read.
  const dir = mkdtempSync(join(tmpdir(), "forge-sandbox-"));
  const settings = join(dir, "settings.json");
  writeFileSync(settings, `${JSON.stringify(sandboxSettings({ writable }), null, 2)}\n`, {
    mode: 0o600,
  });
  return {
    command: "srt",
    // `--` ends the runtime's own options: everything after it is the command, flags included.
    args: ["--settings", settings, "--", command, ...args],
    isolation: {
      process: "srt",
      network: "denied",
      writes: [...writable],
      credentials: "unreadable",
    },
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}
