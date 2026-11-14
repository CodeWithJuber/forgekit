// A remote binding is authorized by a CLI user in this particular checkout. A config
// from git can refer to its fingerprint but cannot select an endpoint or a credential.
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { validateServerName } from "./emit/mcp.js";
import { hasSecret } from "./secrets.js";
import { validatedMcpUrl } from "./source_mcp.js";
import { userStateDir } from "./util.js";

export const ENDPOINTS = Object.freeze({
  deepwiki: {
    url: "https://mcp.deepwiki.com/mcp",
    purpose: "Search documentation for public repositories",
    docs: "https://docs.devin.ai/work-with-devin/deepwiki-mcp",
  },
  exa: {
    url: "https://mcp.exa.ai/mcp",
    purpose: "Web and code research",
    docs: "https://exa.ai/mcp",
  },
  github: {
    url: "https://api.githubcopilot.com/mcp/x/repos/readonly",
    purpose: "Read GitHub repositories with a narrow toolset",
    docs: "https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md",
  },
  gitlab: {
    url: "https://gitlab.com/api/v4/mcp",
    purpose: "GitLab projects; supply your instance URL for Self-Managed",
    docs: "https://docs.gitlab.com/user/model_context_protocol/mcp_server/",
  },
  atlassian: {
    url: "https://mcp.atlassian.com/v2/mcp",
    purpose: "Jira and Confluence Cloud with host-managed authentication",
    docs: "https://support.atlassian.com/atlassian-ai-gateway/docs/use-atlassian-mcp-server/",
  },
  hikmah: {
    url: null,
    purpose: "Connect your own Hikmah Streamable HTTP deployment with --url",
    docs: null,
  },
});

export const validBinding = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const hash = (s) => createHash("sha256").update(s).digest("hex");

export function remoteDefinition(id, url, tokenEnv) {
  validateServerName(id);
  if (id in Object.prototype || id === "forge-cortex") throw new Error("Reserved integration name");
  const href = validatedMcpUrl(url);
  let decoded;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    throw new Error("Invalid MCP endpoint encoding");
  }
  if (hasSecret(decoded) || /[$\\{}\p{Cc}\p{Cf}]/u.test(decoded))
    throw new Error("The MCP endpoint must not contain credentials or variable expressions");
  if (
    tokenEnv !== undefined &&
    (typeof tokenEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,126}$/.test(tokenEnv))
  )
    throw new Error("Supply the bearer token environment variable name");
  return { url: href, ...(tokenEnv === undefined ? {} : { tokenEnv }) };
}

function inDirectory(base, file) {
  const path = relative(base, file);
  return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
}

function bindingFile(root, id, digest) {
  validateServerName(id);
  if (!validBinding(digest)) throw new Error("Invalid remote binding");
  const tree = realpathSync.native(root);
  const state = resolve(userStateDir());
  let parent = state;
  while (!existsSync(parent)) {
    const next = dirname(parent);
    if (parent === next) throw new Error("Cannot locate private state");
    parent = next;
  }
  const actual = join(realpathSync.native(parent), relative(parent, state));
  if (inDirectory(tree, actual))
    throw new Error("Keep the private binding directory outside the working tree");
  const dir = join(actual, "remote-endpoints", hash(tree));
  for (const path of [dirname(dir), dir]) {
    if (existsSync(path) && realpathSync.native(path) !== path)
      throw new Error("Remote bindings cannot follow a symlink");
  }
  return join(dir, `${id}-${digest}.json`);
}

export function bindingDigest(def) {
  return hash(JSON.stringify(def));
}
export function saveBinding(root, id, definition) {
  return savePrivateBinding(root, id, remoteDefinition(id, definition.url, definition.tokenEnv));
}
export function savePrivateBinding(root, id, definition) {
  const body = JSON.stringify(definition);
  const digest = hash(body);
  const file = bindingFile(root, id, digest);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(file, body, { flag: "wx", mode: 0o600 });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    if (!readPrivateBinding(root, id, digest))
      throw new Error("Existing remote binding is unavailable");
  }
  return digest;
}
export function readBinding(root, id, digest) {
  const value = readPrivateBinding(root, id, digest);
  return value ? remoteDefinition(id, value.url, value.tokenEnv) : null;
}
export function readPrivateBinding(root, id, digest) {
  const file = bindingFile(root, id, digest);
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 8192) throw new Error("Invalid private binding file");
    const body = readFileSync(file, "utf8");
    if (hash(body) !== digest) throw new Error("Remote binding fingerprint changed");
    return JSON.parse(body);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
export function forgetBinding(root, id, digest) {
  try {
    unlinkSync(bindingFile(root, id, digest));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}
