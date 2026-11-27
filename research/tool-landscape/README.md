# Tool landscape check, 2026-11-27

A check of the tools, protocols and papers that came up while planning ForgeKit's next work.
Every row was verified from a primary source on 2026-11-27. The point of keeping it here is
that several statements commonly repeated about these tools turned out to be wrong or stale,
and three of the papers changed what ForgeKit should build.

## How each item was checked

- A repository: a shallow clone without checkout (`git clone --depth 1 --filter=blob:none
  --no-checkout`), then the date of the last commit and the text of the license file. 137
  distinct repositories were checked this way; all resolve.
- A package version: the npm, PyPI or crates registry.
- A paper: the arXiv API, by identifier. 21 papers behind planning claims all resolve; 18 more
  were read because they bear on a verdict.
- A specification: the text in its own repository at the tagged revision.

Not checked: star counts and download counts. The GitHub API was not reachable for other
people's repositories from the machine that ran the check, so no popularity number appears here.
"Last commit" is the default branch on the day of the check and will go stale.

## What changed a decision

| Finding | Source | Consequence for ForgeKit |
| --- | --- | --- |
| 21 routers on 5 benchmarks land in one narrow band far below an oracle, and a nearest-neighbour baseline does as well | arXiv:2606.07587, arXiv:2601.07206 | No new learned router. Effort went into the cascade's cost forecast instead (`docs/UNIVERSAL_ROUTING.md`) |
| Of 21 skills that helped on training tasks, 5 kept the whole gain on held-out tasks, 13 part of it, 3 none | arXiv:2609.39148 | A saved procedure is promoted only on held-out evidence (`src/mathcore/promotion.js`) |
| Neutral filler costs a model almost nothing; a statement of the same form with a rival value costs 9 to 110 times more | arXiv:2611.04169 | Context packing removes rival values instead of only shortening (`src/mathcore/rivals.js`, used by `forge context`) |
| 52.9% of 78,612 SBOMs declare no dependency edges; for 61.7% a missing path says nothing about reachability | arXiv:2607.22140 | Reachability is three-valued; "not found" never suppresses a finding (`src/mathcore/vulnrank.js`) |
| Poisoned tool descriptions succeeded in 22.9% of runs across 12 agent frameworks | arXiv:2611.03555 | A third-party MCP endpoint's tool list can be pinned by digest (`mcp.surface`, `docs/AGENT-EVIDENCE.md`) |
| MCP revision 2026-07-28 is stateless: no `initialize`, no session id, `server/discover` required | MCP specification repository, tag 2026-07-28 | ForgeKit's server answers both the new and the older revisions (`src/cortex_mcp.js`) |

## Statements that did not hold

| Statement | What the source shows |
| --- | --- |
| RouteLLM is the routing library to adopt | Last commit 2024-08-10 |
| ACP is a protocol to plan for | Its README says it is now part of A2A under the Linux Foundation |
| stack-graphs for name resolution | Last commit 2025-09-09 |
| GitNexus as a code-graph dependency | PolyForm Noncommercial license |
| Lightpanda, Firecrawl, basic-memory as embeddable components | AGPL-3.0 |
| aider's repo map as a maintained building block | Last commit 2026-05-22 |
| GPTCache for response caching | Last commit 2026-09-22, and it caches by similarity, which ForgeKit's reuse cache deliberately does not |
| "MiniCache" as a parameterised program cache | The only arXiv paper of that name (2405.14366) is about key-value cache compression, a different thing |
| WebMCP is a web standard | One browser engine has an origin trial; the other two have published no position |
| A git worktree is a sandbox | It isolates files only. Process confinement needs a runtime such as `srt` (`src/sandbox.js`) |

## Register

Verdicts are about use inside ForgeKit, which ships with zero runtime dependencies: "external
tool" means a user may install it and ForgeKit may call it, never that it is bundled.

| Tool | Area | Last commit | License | Verdict |
| --- | --- | --- | --- | --- |
| [joernio/joern](https://github.com/joernio/joern) | Code graph | 2026-11-26 | Apache 2.0 | External tool for taint questions |
| [Lekssays/codebadger](https://github.com/Lekssays/codebadger) | Code graph | 2026-11-26 | GPL 3.0 | External only, because of the license |
| [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) | Code graph | 2026-11-27 | MIT | Candidate integration after an installer review |
| [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph) | Code graph | 2026-11-23 | MIT | Candidate integration |
| [abhigyanpatwari/GitNexus](https://github.com/abhigyanpatwari/GitNexus) | Code graph | 2026-11-26 | PolyForm Noncommercial | Avoid in a commercial product |
| [yamadashy/repomix](https://github.com/yamadashy/repomix) | Code graph | 2026-11-26 | MIT | Fine for one-off packing |
| [Aider-AI/aider](https://github.com/Aider-AI/aider) | Code graph | 2026-05-22 | Apache 2.0 | No commit since May 2026 |
| [tree-sitter/tree-sitter](https://github.com/tree-sitter/tree-sitter) | Code graph | 2026-11-26 | MIT | Optional parser tier |
| [github/stack-graphs](https://github.com/github/stack-graphs) | Code graph | 2025-09-09 | Apache 2.0 | No commit since September 2025. Do not adopt |
| [getzep/graphiti](https://github.com/getzep/graphiti) | Memory | 2026-11-26 | Apache 2.0 | Take the idea of validity on every fact |
| [OSU-NLP-Group/HippoRAG](https://github.com/OSU-NLP-Group/HippoRAG) | Memory | 2026-10-06 | MIT | Take the idea of a seeded graph walk |
| [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem) | Memory | 2026-11-26 | Apache 2.0 | Works beside ForgeKit |
| [basicmachines-co/basic-memory](https://github.com/basicmachines-co/basic-memory) | Memory | 2026-11-25 | AGPL 3.0 | Do not bundle |
| [automerge/automerge](https://github.com/automerge/automerge) | Memory | 2026-11-26 | MIT | Not needed. The ledger is already a CRDT |
| [loro-dev/loro](https://github.com/loro-dev/loro) | Memory | 2026-11-25 | MIT | Not needed |
| [vlcn-io/cr-sqlite](https://github.com/vlcn-io/cr-sqlite) | Memory | 2026-08-10 | MIT | No commit since August 2026 |
| [lm-sys/RouteLLM](https://github.com/lm-sys/RouteLLM) | Routing | 2024-08-10 | Apache 2.0 | No commit since August 2024. Do not build on it |
| [BerriAI/litellm](https://github.com/BerriAI/litellm) | Routing | 2026-11-27 | Mixed terms | Optional gateway |
| [diegosouzapw/OmniRoute](https://github.com/diegosouzapw/OmniRoute) | Routing | 2026-11-26 | MIT | Optional gateway |
| [obra/superpowers](https://github.com/obra/superpowers) | Skills and replay | 2026-11-03 | MIT | Reference skill set |
| [github/spec-kit](https://github.com/github/spec-kit) | Skills and replay | 2026-11-25 | MIT | Reference. spec-lock checks the specs such tools write |
| [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) | Skills and replay | 2026-11-23 | MIT | Reference skill set |
| [mattpocock/skills](https://github.com/mattpocock/skills) | Skills and replay | 2026-11-25 | MIT | Reference skill set |
| [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) | Skills and replay | 2026-11-25 | Apache 2.0 | Terse-output skill. Its savings figure is self-reported |
| [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) | Skills and replay | 2026-11-22 | MIT | Restraint rule against over-building. Reference |
| [aurelio-labs/semantic-router](https://github.com/aurelio-labs/semantic-router) | Skills and replay | 2026-11-25 | MIT | Matching only |
| [browserbase/stagehand](https://github.com/browserbase/stagehand) | Skills and replay | 2026-11-25 | MIT | Reference for cache then self-heal |
| [zilliztech/GPTCache](https://github.com/zilliztech/GPTCache) | Skills and replay | 2026-09-22 | MIT | No commit since September 2026 |
| [logpai/Drain3](https://github.com/logpai/Drain3) | Skills and replay | 2025-02-03 | MIT | No commit since February 2025 |
| [OSU-NLP-Group/SkillWeaver](https://github.com/OSU-NLP-Group/SkillWeaver) | Skills and replay | 2025-04-14 | MIT | Research code. No commit since April 2025 |
| [lightpanda-io/browser](https://github.com/lightpanda-io/browser) | Browser | 2026-11-27 | AGPL 3.0 | Light engine. Mind the license |
| [cloudflare/kitesurf](https://github.com/cloudflare/kitesurf) | Browser | 2026-11-26 | Apache 2.0 | Light engine on Workers. Experimental |
| [lexmount/moli](https://github.com/lexmount/moli) | Browser | 2026-11-27 | Apache 2.0 | Light engine |
| [DioxusLabs/blitz](https://github.com/DioxusLabs/blitz) | Browser | 2026-11-27 | Apache 2.0 | Building block, beta |
| [microsoft/playwright](https://github.com/microsoft/playwright) | Browser | 2026-11-26 | Apache 2.0 | Already optional in ForgeKit |
| [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) | Browser | 2026-11-18 | Apache 2.0 | In the catalog, one version behind |
| [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) | Browser | 2026-11-26 | Apache 2.0 | Candidate integration |
| [browser-use/browser-use](https://github.com/browser-use/browser-use) | Browser | 2026-11-26 | MIT | Python. Not needed |
| [Kaliiiiiiiiii-Vinyzu/patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) | Browser | 2026-11-12 | Apache 2.0 | Evasion. Do not ship |
| [daijro/camoufox](https://github.com/daijro/camoufox) | Browser | 2026-11-25 | MPL 2.0 | Evasion. Do not ship |
| [firecrawl/firecrawl](https://github.com/firecrawl/firecrawl) | Browser | 2026-11-26 | AGPL 3.0 | Hosted scraping. Do not bundle |
| [langchain-ai/openwiki](https://github.com/langchain-ai/openwiki) | Documentation | 2026-11-17 | MIT | Generates pages with a model. Can run beside ForgeKit's checks |
| [open-knowledge-format/open-knowledge-format](https://github.com/open-knowledge-format/open-knowledge-format) | Documentation | 2026-11-18 | Apache 2.0 | Export target for documentation metadata |
| [stoplightio/spectral](https://github.com/stoplightio/spectral) | Documentation | 2026-11-13 | Apache 2.0 | Use for OpenAPI files if a project has them |
| [anthropic-experimental/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime) | Sandbox and system | 2026-11-12 | Apache 2.0 | First choice sandbox for hosts without one |
| [multikernel/sandlock](https://github.com/multikernel/sandlock) | Sandbox and system | 2026-11-25 | Apache 2.0 | Linux, recent kernels |
| [tursodatabase/agentfs](https://github.com/tursodatabase/agentfs) | Sandbox and system | 2026-06-03 | See licenses folder | No commit since June 2026 |
| [e2b-dev/E2B](https://github.com/e2b-dev/E2B) | Sandbox and system | 2026-11-26 | Apache 2.0 | Hosted microVMs. Not needed locally |
| [daytonaio/daytona](https://github.com/daytonaio/daytona) | Sandbox and system | 2026-06-25 | No license file at root | No commit since June 2026 |
| [firecracker-microvm/firecracker](https://github.com/firecracker-microvm/firecracker) | Sandbox and system | 2026-11-25 | Apache 2.0 | Server side only |
| [trycua/cua](https://github.com/trycua/cua) | Sandbox and system | 2026-11-27 | MIT | Desktop control. Outside scope |
| [HKUDS/CLI-Anything](https://github.com/HKUDS/CLI-Anything) | Sandbox and system | 2026-09-22 | Apache 2.0 | No commit since September 2026 |
| [hardware-mcp/arduino-mcp-server](https://github.com/hardware-mcp/arduino-mcp-server) | Sandbox and system | 2026-08-22 | MIT | Outside scope |
| [usestrix/strix](https://github.com/usestrix/strix) | Security | 2026-11-25 | Apache 2.0 | External proof-of-concept testing |
| [google/osv-scanner](https://github.com/google/osv-scanner) | Security | 2026-11-24 | Apache 2.0 | ForgeKit already reads OSV |
| [invariantlabs-ai/mcp-scan](https://github.com/invariantlabs-ai/mcp-scan) | Security | 2026-11-26 | Apache 2.0 | External scanner. Reference |
| [google-research/camel-prompt-injection](https://github.com/google-research/camel-prompt-injection) | Security | 2025-06-20 | Apache 2.0 | Research artifact. No commit since June 2025 |
| [gitleaks/gitleaks](https://github.com/gitleaks/gitleaks) | Security | 2026-10-23 | MIT | Already used by harden |
| [modelcontextprotocol/modelcontextprotocol](https://github.com/modelcontextprotocol/modelcontextprotocol) | Protocols | 2026-11-26 | License in transition | Revision 2026-07-28 now supported by the server |
| [a2aproject/A2A](https://github.com/a2aproject/A2A) | Protocols | 2026-11-25 | Apache 2.0 | Target for agent to agent calls |
| [i-am-bee/acp](https://github.com/i-am-bee/acp) | Protocols | 2025-08-25 | Apache 2.0 | Merged into A2A |
| [ag-ui-protocol/ag-ui](https://github.com/ag-ui-protocol/ag-ui) | Protocols | 2026-11-23 | MIT | Only if the dashboard becomes interactive |
| [agentskills/agentskills](https://github.com/agentskills/agentskills) | Protocols | 2026-11-04 | Apache 2.0 | Already emitted |
| [pbakaus/impeccable](https://github.com/pbakaus/impeccable) | Design skills | 2026-11-26 | Apache 2.0 | Reference rules |
| [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill) | Design skills | 2026-11-27 | MIT | Reference |
| [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | Design skills | 2026-11-27 | MIT | Reference |
| [cathrynlavery/diagram-design](https://github.com/cathrynlavery/diagram-design) | Design skills | 2026-11-26 | MIT | Reference |
| [openclaw/openclaw](https://github.com/openclaw/openclaw) | Named as market signals | 2026-11-27 | MIT | A host ForgeKit already emits config for |
| [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | Named as market signals | 2026-11-26 | MIT | No action |
| [n8n-io/n8n](https://github.com/n8n-io/n8n) | Named as market signals | 2026-11-27 | Fair-code terms | No action |
| [langgenius/dify](https://github.com/langgenius/dify) | Named as market signals | 2026-11-27 | Modified Apache 2.0 | No action |
| [mvanhorn/last30days-skill](https://github.com/mvanhorn/last30days-skill) | Named as market signals | 2026-11-26 | MIT | Live research skill. Reference |
| [Panniantong/Agent-Reach](https://github.com/Panniantong/Agent-Reach) | Named as market signals | 2026-11-24 | MIT | Live research skill. Reference |
| [morluto/rea](https://github.com/morluto/rea) | Named as market signals | 2026-11-27 | MIT | Exists. Purpose not reviewed |
| [milind-soni/OpenMausBot](https://github.com/milind-soni/OpenMausBot) | Named as market signals | 2026-11-27 | Apache 2.0 | Exists. Purpose not reviewed |
| [Tracer-Cloud/opensre](https://github.com/Tracer-Cloud/opensre) | Named as market signals | 2026-11-26 | Apache 2.0 | Exists. Purpose not reviewed |
