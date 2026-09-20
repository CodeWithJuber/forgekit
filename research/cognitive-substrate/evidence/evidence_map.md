# Evidence Map: Independent Re-Grounding of Pain-Point Statistics

*12 load-bearing claims verified against primary sources, 5 confirmed, 5 vendor-only, 2 unverifiable.*

## Summary Table

| # | Claim | Primary Source | Status | Key Discrepancy |
|---|---|---|---|---|
| 1 | Experienced open-source developers were 19% SLOWER with AI while believing they were ~20% ... | arXiv preprint / METR blog (2025) | ✅ confirmed | See note |
| 2 | Trust in AI accuracy fell from 40% to 29% (or 46% actively distrust vs 33% trust per detai... | Stack Overflow (2025) | ✅ confirmed | See note |
| 3 | 45% of AI-generated code samples introduce an OWASP Top-10 vulnerability; a widely-repeate... | Veracode (2025) | ⚠️ vendor-only | See note |
| 4 | ~8x rise (2024 vs prior years) in frequency of duplicated/copy-pasted code blocks; copy-pa... | GitClear (Bill Harding et al.) (2025) | ⚠️ vendor-only | GitClear's own title says 4x, body/press say 8x - unresolved |
| 5 | AI's primary role is as an 'amplifier' - magnifying high performers' strengths and low per... | Official DORA/Google Cloud report (2025) | ✅ confirmed | See note |
| 6 | OpenAI retired SWE-bench Verified (Feb 2026) after finding at least 59.4% of audited (hard... | OpenAI official blog (2026) | ✅ confirmed | See note |
| 7 | Median time in PR review up 441.5%; incidents-per-PR up 242.7%; bugs per developer up 54%;... | Faros AI (2026) | ⚠️ vendor-only | See note |
| 8 | Developers who delegate code generation to AI score 17% lower on comprehension tests, base... | (a) arXiv preprint; (b) Anthropic official research page (2026) | ❌ unverifiable | See note |
| 9 | 96% of developers don't fully trust AI-generated code is functionally correct, yet only 48... | Sonar (2026) | ⚠️ vendor-only | See note |
| 10 | JetBrains' 2025 survey found 77% of developers still manually correct AI output for projec... | JetBrains (2025) | ❌ unverifiable | See note |
| 11 | A standard MCP setup (few servers) can consume ~72% of a 200K-token context window before ... | (b) Qiyao Sun et al. (2025) | ⚠️ vendor-only | See note |
| 12 | LLM evaluators recognize and favor their own generations - self-preference bias correlates... | Advances in Neural Information Processing Systems 37 (NeurIPS 2024), Main Conference Track (Oral) (2024) | ✅ confirmed | See note |

## Detailed Findings

### 1. C1_METR_slowdown: ✅ confirmed

**Claim:** Experienced open-source developers were 19% SLOWER with AI while believing they were ~20% faster (also forecast 24% speedup beforehand).

**Supports:** M2 (assumption/uncertainty - miscalibration), P3/self-correction deficit; core 'trust but verify' motivation

**Primary source:** *Measuring the Impact of Early-2025 AI on Experienced Open-Source Developer Productivity* — METR (Model Evaluation & Threat Research), arXiv preprint / METR blog, 2025. arXiv:2507.09089; https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/

**What the primary source actually states:** 16 experienced developers, 246 tasks in mature repos (avg 22k+ stars, 1M+ lines); AI use INCREASED completion time by 19%; pre-task forecast was 24% speedup; post-task self-estimate was 20% speedup.

**What the field report claimed:** 19% slowdown for experienced devs; matches primary source exactly.

**Note:** Directly reachable on arXiv and METR's own site; numbers match field report exactly. Caveat directly stated by METR: small sample (16 devs), specific to mature/familiar open-source repos, and AI-averse developers increasingly decline to participate (self-selection risk noted by METR itself).

### 2. C2_SO2025_trust: ✅ confirmed

**Claim:** Trust in AI accuracy fell from 40% to 29% (or 46% actively distrust vs 33% trust per detailed breakdown); favorability 72%->60%; 66% say AI answers are 'almost right, but not quite'; 45% say debugging AI code is more time-consuming.

**Supports:** M2 uncertainty/calibration; M6 inline verification; overall trust/verification-gap thesis

**Primary source:** *2025 Stack Overflow Developer Survey (49,000+ respondents, 177 countries)* — Stack Overflow, Official survey site / Stack Overflow company blog + press release, 2025. https://survey.stackoverflow.co/2025 ; https://survey.stackoverflow.co/2025/ai ; https://stackoverflow.blog/2025/12/29/developers-remain-willing-but-reluctant-to-use-ai-the-2025-developer-survey-results-are-here/

**What the primary source actually states:** Trust in AI accuracy fell from 40% (prior years) to 29% (2025); positive favorability fell from 72% to 60%; 84% use or plan to use AI tools (up from 76%); 46% actively distrust AI accuracy vs 33% trust it, only 3% 'highly trust'; 66% cite 'almost right, but not quite' as the #1 frustration, which 'often leads to' the #2 frustration, debugging being more time-consuming (45%).

**What the field report claimed:** Matches primary source essentially exactly on all four sub-figures.

**Note:** Reached directly on Stack Overflow's own survey site and company blog. Self-reported survey; Stack Overflow's own methodology notes flag respondent self-selection bias (recruited via Stack Overflow's own channels, so more AI-engaged/skeptical developers may be over-represented).

### 3. C3_Veracode_vuln: ⚠️ vendor-only

**Claim:** 45% of AI-generated code samples introduce an OWASP Top-10 vulnerability; a widely-repeated '2.74x more vulnerabilities than human-written code' figure.

**Supports:** M5 anti-over-engineering / code-quality thesis; security-verification gap

**Primary source:** *2025 GenAI Code Security Report* — Veracode, Veracode company report/blog, 2025. https://www.veracode.com/resources/analyst-reports/2025-genai-code-security-report/ ; https://www.veracode.com/blog/genai-code-security-report/

**What the primary source actually states:** Veracode's own report/blog states only the 45% figure (code samples across 100+ LLMs, Java/JS/Python/C# introducing OWASP Top-10 flaws; Java worst at ~72%; XSS failure 86%). Veracode's own public materials located in this search do NOT state a '2.74x' multiplier anywhere.

**What the field report claimed:** Field report attributes BOTH '45%' and '2.74x more vulnerabilities than human-written code' to Veracode, then separately says the 2.74x figure was 'independently corroborated by CodeRabbit's December 2025 analysis of 470 real-world PRs (2.74x more security vulnerabilities...)'.

**Note:** The 45% figure is directly traceable to Veracode's own report (vendor self-reported, not independently reproduced). The '2.74x' figure could NOT be located in Veracode's own primary materials during this search - it appears only in secondary/derivative blog posts (e.g. softwareseni.com) that attribute it to Veracode, while the field report itself sources the same 2.74x number to a DIFFERENT study (CodeRabbit's PR analysis). This looks like a citation conflation between two separate vendor studies that happen to share a number. Treat the 2.74x figure as unverified/possibly misattributed pending direct access to Veracode's full PDF report.

### 4. C4_GitClear_duplication: ⚠️ vendor-only

**Claim:** ~8x rise (2024 vs prior years) in frequency of duplicated/copy-pasted code blocks; copy-paste overtaking refactored ('moved') code for the first time.

**Supports:** M5 anti-over-engineering; long-term codebase impact-awareness (P5-related)

**Primary source:** *AI Copilot Code Quality: 2025 Data Suggests 4x Growth in Code Clones / AI Copilot Code Quality: Evaluating 2024's Increased Defect Rate* — GitClear (Bill Harding et al.), GitClear company research report, 2025. https://www.gitclear.com/ai_assistant_code_quality_2025_research ; https://gitclear-public.s3.us-west-2.amazonaws.com/GitClear-AI-Copilot-Code-Quality-2025.pdf

**What the primary source actually states:** GitClear's own materials are internally inconsistent on the multiplier. The report's own page TITLE reads 'AI Copilot Code Quality: 2025 Data Suggests 4x Growth in Code Clones' (gitclear.com), but the body text of the same report and GitClear's press-mentions page both state duplicated code blocks (5+ lines) 'rose eightfold' / 'increased eightfold' during 2024 (211M changed lines, 2020-2024, Google/Microsoft/Meta/enterprise repos). Secondary summaries split roughly evenly between citing '4x' and '8x'. Underlying non-disputed figures: copy-pasted lines rose from 8.3% (2020) to 12.3% (2024); moved/refactored lines fell from ~24-25% to <10%; 2024 was the first year copy-paste exceeded moved lines. The 4x-vs-8x gap could not be resolved from available pages - likely reflects two different metrics (duplicated-block frequency vs. some other clone measure) reported inconsistently across GitClear's own title/body/press materials.

**What the field report claimed:** Field report states '8x rise in duplicated code blocks' - this matches GitClear's report BODY and press-mentions page, but GitClear's own page TITLE says '4x Growth in Code Clones,' an internal inconsistency the field report does not surface.

**Note:** GitClear is a code-analytics vendor; findings are corroborated by many independent tech-press writeups summarizing the same underlying dataset, but no independent third party has re-run the analysis separately. Correlational, not causal. IMPORTANT ADDITIONAL CAVEAT: GitClear's own materials are internally inconsistent - the report's page title cites '4x' growth in code clones while the body and press page cite an '8x' rise in duplicated blocks. The paper should either cite the specific metric name (duplicated-block frequency, 8x per body text) rather than a bare multiplier, or note both figures and the discrepancy explicitly rather than asserting '8x' as settled.

### 5. C5_DORA_amplifier: ✅ confirmed

**Claim:** AI's primary role is as an 'amplifier' - magnifying high performers' strengths and low performers' dysfunctions; AI continues to increase delivery instability even as adoption becomes near-universal.

**Supports:** Systemic framing for all six mechanisms (org context matters, not just model quality)

**Primary source:** *State of AI-assisted Software Development 2025 (DORA Report)* — Google Cloud DORA team (Nathen Harvey et al.), in collaboration with research partners, Official DORA/Google Cloud report, 2025. https://dora.dev/dora-report-2025/ ; https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report

**What the primary source actually states:** Nearly 5,000 professionals surveyed (June 13-July 21, 2025) plus 100+ hours interviews; 90% AI adoption (14pp increase from 2024); AI's primary role is 'that of an amplifier... magnifying the strengths of high-performing organisations and the dysfunctions of struggling ones'; in 2025 AI's relationship to delivery throughput reversed to positive vs 2024, but AI continues to increase delivery instability; ~30% report little/no trust in AI-generated code.

**What the field report claimed:** Matches primary source directly ('AI is an amplifier'; high adoption; throughput/stability tension).

**Note:** DORA is a Google-run but methodologically transparent, widely-cited industry research program (not a single vendor's self-promotional study); full methodology, sample size and survey window are published. Best-supported of the twelve claims alongside METR.

### 6. C6_SWEbench_retirement: ✅ confirmed

**Claim:** OpenAI retired SWE-bench Verified (Feb 2026) after finding at least 59.4% of audited (hard/failed) problems had flawed test cases and/or training-data contamination; large score gap vs SWE-bench Pro (e.g. one model ~80.9% Verified vs ~45.9% Pro).

**Supports:** M6 inline verification / benchmark-trust thesis; supports 'AI output is probabilistic, don't blindly trust metrics'

**Primary source:** *Why SWE-bench Verified no longer measures frontier coding capabilities* — OpenAI Frontier Evals team (Mia Glaese, Olivia Watkins et al.), OpenAI official blog, 2026. https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/

**What the primary source actually states:** OpenAI audited 138 problems (27.6% subset of the 500-task set) that its o3 model could not reliably solve across 64 runs; found at least 59.4% of THOSE audited problems had flawed test cases/descriptions (35.5% narrow tests, 18.8% wide tests, 5.1% other); also found all tested frontier models could reproduce gold-patch solutions from training memory, indicating contamination. The specific 80.9%-Verified-vs-45.9%-Pro pairing (Claude Opus 4.5) was NOT found stated in OpenAI's own blog; it is reported by third-party benchmark aggregators (e.g. Scale AI SEAL leaderboard, BenchLM.ai, cited via codeant.ai) as of April 2026.

**What the field report claimed:** Field report's phrasing ('59.4% of audited problems had flawed test cases') is accurate to primary source. The 80.9%/45.9% pairing is directionally correct (large real gap exists) but its precise sourcing is a third-party leaderboard snapshot, not OpenAI's own blog post.

**Note:** The 59.4%-of-audited-problems figure is directly confirmed on OpenAI's own site - a strong, well-documented primary source. The specific 80.9/45.9 percentage pair is a real, traceable leaderboard snapshot (Scale AI SEAL/BenchLM) but should be cited as such, not as OpenAI's own number, and will drift as models are re-benchmarked.

### 7. C7_Faros_PRreview: ⚠️ vendor-only

**Claim:** Median time in PR review up 441.5%; incidents-per-PR up 242.7%; bugs per developer up 54%; 31.3% more PRs merged with no review at all.

**Supports:** M6 inline verification; review-bottleneck / verification-layer thesis

**Primary source:** *The AI Engineering Report 2026: The Acceleration Whiplash* — Faros AI, Faros AI company research report (telemetry analysis), 2026. https://pages.faros.ai/hubfs/AI_Engineering_Report_2026_The_Acceleration_Whiplash_Faros.pdf ; https://www.faros.ai/blog/ai-acceleration-whiplash-takeaways

**What the primary source actually states:** Two years of telemetry from 22,000 developers / 4,000+ teams, comparing each org's lowest- vs highest-AI-adoption quarters: median time in PR review +441.5% (average time in review +199.6%, first-review wait +156.6%); incidents-to-PR ratio +242.7%; bugs per developer +54%; 31.3% more PRs merged with no review at all; code churn +861%.

**What the field report claimed:** Matches primary source numbers exactly.

**Note:** Faros AI is an engineering-intelligence vendor whose commercial product monitors exactly these metrics; the report itself and third-party coverage (ADTmag) note these are cross-sectional correlations across the vendor's own customer telemetry, not a controlled study, and 2025-vs-2026 report editions are independent cross-sections rather than a longitudinal panel.

### 8. C8_Anthropic_comprehension: ❌ unverifiable

**Claim:** Developers who delegate code generation to AI score 17% lower on comprehension tests, based on 'Anthropic's own research (~400,000 Claude Code sessions)'.

**Supports:** M6 inline verification / skill-atrophy thesis (comprehension while writing, not only after)

**Primary source:** *TWO DIFFERENT STUDIES ARE BEING CONFLATED: (a) 'How AI Impacts Skill Formation' by Judy Hanwen Shen & Alex Tamkin (arXiv, 2026) - the actual source of the '17% lower comprehension' figure; (b) 'How Claude Code is used in practice' (Anthropic, ~400,000-session analysis) - a real Anthropic study, but about planning/execution decision splits and task-success rates, NOT comprehension testing.* — (a) Judy Hanwen Shen, Alex Tamkin (Tamkin at Anthropic); (b) Anthropic, (a) arXiv preprint; (b) Anthropic official research page, 2026. (a) referenced via arxiv.org/pdf/2604.14228 citing 'Shen and Tamkin, 2026'; (b) https://www.anthropic.com/research/claude-code-expertise

**What the primary source actually states:** (a) Shen & Tamkin: developers who used AI to learn a new async-programming library completed tasks but scored measurably worse on a post-task comprehension test ('17% lower' per a secondary citation in an arXiv survey paper - I could not independently pull Shen & Tamkin's own abstract/number in this search, only a citing paper's paraphrase). (b) The 400,000-session Anthropic study found users make ~70% of planning decisions and Claude makes ~80% of execution decisions; occupation-based success rates were similar across professions (~26-34%); it does NOT report a comprehension-score deficit.

**What the field report claimed:** Field report merges these into one sentence ('Anthropic's own research (~400,000 Claude Code sessions) found... 17% lower on comprehension'), incorrectly attributing the comprehension finding to the session-count study.

**Note:** This is a citation-conflation error carried over from the field report (or its own sources). The 400K-session study is real and directly confirmed, but does not contain a comprehension-deficit finding. The '17% lower comprehension' figure traces to a separate, distinct Shen & Tamkin paper that this search could not directly retrieve/confirm in primary form (only via a third paper's citation of it). RECOMMENDATION: if the white paper wants to use the comprehension-deficit claim, cite Shen & Tamkin (2026) directly and verify the 17% figure against their own abstract/paper before use; do not attribute it to the 400K-session study.

### 9. C9_Sonar_verification_gap: ⚠️ vendor-only

**Claim:** 96% of developers don't fully trust AI-generated code is functionally correct, yet only 48% always verify it before committing (a 48-point 'verification gap'/'verification debt').

**Supports:** M6 inline verification - the central named gap the mechanism targets

**Primary source:** *State of Code Developer Survey report 2026* — Sonar, Sonar company press release / report PDF, 2026. https://www.sonarsource.com/company/press-releases/sonar-data-reveals-critical-verification-gap-in-ai-coding/ ; https://www.sonarsource.com/state-of-code-developer-survey-report.pdf

**What the primary source actually states:** Survey of 1,100+ (some sources say 1,149) professional developers, January 2026: 96% do not fully trust AI-generated code is functionally correct; only 48% always check AI-assisted code before committing; AI accounts for 42% of committed code (projected 65% by 2027); 38% say reviewing AI code takes more effort than reviewing human code; the term 'verification debt' is attributed to AWS CTO Werner Vogels.

**What the field report claimed:** Matches primary source exactly.

**Note:** Sonar is a code-quality/verification tooling vendor with a direct commercial interest in this narrative; numbers are self-reported survey data, not independently replicated, though the survey size and methodology are transparently disclosed in the primary PDF.

### 10. C10_JetBrains_manual_correction: ❌ unverifiable

**Claim:** JetBrains' 2025 survey found 77% of developers still manually correct AI output for project conventions every session.

**Supports:** M4 goal-anchoring / M5 anti-over-engineering (convention drift)

**Primary source:** *The State of Developer Ecosystem 2025* — JetBrains, JetBrains official survey report, 2025. https://blog.jetbrains.com/research/2025/10/state-of-developer-ecosystem-2025/ ; https://devecosystem-2025.jetbrains.com/artificial-intelligence

**What the primary source actually states:** JetBrains' own 2025 report (24,534 developers) confirms 85% regularly use AI tools and 62% rely on at least one AI coding assistant, but this search could not locate any statement of a '77% manually correct AI output for conventions every session' figure anywhere in JetBrains' own materials, blog posts, or press coverage of the 2025 or 2026 editions.

**What the field report claimed:** 77% manually correct for conventions every session (attributed to JetBrains 2025).

**Note:** Could not confirm this specific statistic in JetBrains' own primary materials despite multiple targeted searches of the official report, its AI-specific subpage, and secondary coverage. It may be a misremembered/misattributed figure, or drawn from the raw downloadable dataset (500+ questions) rather than the published highlights - the field report should either drop this figure or the paper authors should independently pull it from JetBrains' raw data release before use.

### 11. C11_MCP_context_bloat: ⚠️ vendor-only

**Claim:** A standard MCP setup (few servers) can consume ~72% of a 200K-token context window before work begins; tool-selection accuracy drops from ~43% to below ~14% as tool count scales ('context rot').

**Supports:** M1 complexity-aware routing / M3 task decomposition (context budget as a resource to manage)

**Primary source:** *(a) 72%-context-window claim: no formal paper found, only recurring blog anecdotes (Scott Spence, Sam McLeod, apideck.com, agentpmt.com) describing an informal measurement ('three servers - GitHub, Playwright, IDE - consumed 143K of 200K tokens'). (b) 43%->14% tool-selection accuracy: RAG-MCP: Mitigating Prompt Bloat in LLM Tool Selection via Retrieval-Augmented Generation.* — (b) Qiyao Sun et al., (b) arXiv preprint, 2025. (b) arXiv:2505.03275

**What the primary source actually states:** (b) RAG-MCP's own 'MCP stress test' (needle-in-a-haystack-style, N candidate MCP schemas with 1 ground truth) found baseline tool-selection accuracy of 13.62% vs 43.13% for their retrieval-augmented method at scale - i.e. the '43% vs 14%' figures are RAG-MCP's OWN method-vs-baseline comparison on a synthetic stress test, not a general real-world degradation curve as tools accumulate. (a) The 72%/143K-token figure is not from any peer-reviewed or vendor-formal study located in this search; it recurs across multiple blogs as an informal, uncredited individual measurement (one specific developer's personal setup: GitHub + Playwright + IDE MCP servers).

**What the field report claimed:** Field report states these as if they describe general degradation with tool count ('tool-selection accuracy drops from 43% to below 14% as tools accumulate') and cites a 72% context-window consumption figure as an established fact.

**Note:** The 43.13%-vs-13.62% numbers ARE real and traceable to a genuine arXiv paper (RAG-MCP), but the field report's framing ('as tools accumulate') mischaracterizes what those specific numbers measure (a baseline vs their proposed retrieval method on one synthetic stress test, not a general accumulation curve). The 72%-window figure has no traceable primary/academic source - only recurring, uncredited blog claims. RECOMMENDATION: if used, cite RAG-MCP correctly as 'a stress test showing retrieval-based tool selection outperforms naive selection at scale' rather than a general context-rot statistic, and treat the 72% figure as illustrative anecdote, not a verified finding.

### 12. C12_Panickssery_selfpreference: ✅ confirmed

**Claim:** LLM evaluators recognize and favor their own generations - self-preference bias correlates with self-recognition ability - motivating why 'AI verifying AI' is structurally weak.

**Supports:** M6 inline verification (why an LLM cannot be its own sole verifier); underpins the paper's argument for independent/external verification loops

**Primary source:** *LLM Evaluators Recognize and Favor Their Own Generations* — Arjun Panickssery, Samuel R. Bowman, Shi Feng, Advances in Neural Information Processing Systems 37 (NeurIPS 2024), Main Conference Track (Oral), 2024. https://proceedings.neurips.cc/paper_files/paper/2024/hash/7f1f0218e45f5414c79c0679633e47bc-Abstract-Conference.html ; arXiv:2404.13076

**What the primary source actually states:** GPT-4 and Llama 2, used as evaluators, have 'non-trivial accuracy' at distinguishing their own outputs from other LLMs' and humans' outputs; a linear correlation is found between self-recognition capability and strength of self-preference bias (LLM evaluators score their own outputs higher while human annotators rate them as equal quality); fine-tuning to improve self-recognition further amplifies self-preference.

**What the field report claimed:** Field report's characterization ('LLMs show self-preference/self-recognition bias when evaluating') matches the paper's core finding faithfully; no specific number is claimed by the field report beyond the qualitative finding.

**Note:** Directly confirmed via the official NeurIPS 2024 proceedings page and the underlying arXiv preprint; a peer-reviewed, widely-cited paper (an NeurIPS 2024 Oral). This is the strongest-quality citation among all twelve (peer-reviewed venue, not industry survey/vendor report).

## What This Means for the Paper


**Safe to lean on without hedging (peer-reviewed / official primary source, methodology transparent):**
- METR's 19%-slowdown RCT (C1) — the single best-controlled empirical finding in the set; cite with its own caveats (n=16, mature-repo setting).
- Panickssery et al. NeurIPS 2024 self-preference bias (C12) — the only genuinely peer-reviewed academic paper among the twelve; strongest citation for the M6 argument that an LLM cannot be its sole verifier.
- OpenAI's own retirement of SWE-bench Verified and the 59.4%-of-audited-problems figure (C6) — directly stated on OpenAI's blog. The specific 80.9%/45.9% score pairing, however, should be cited as a third-party leaderboard snapshot (Scale AI SEAL/BenchLM), not as OpenAI's own number, since it will drift release-to-release.
- DORA 2025 "AI is an amplifier" finding (C5) — large, transparent, non-vendor-captured methodology (Google Cloud + independent research partners), the most credible of the survey-based claims.
- Stack Overflow 2025 trust figures (C2) — official large-sample survey (49k+ respondents) with disclosed methodology; cite with the self-selection caveat Stack Overflow itself notes.

**Usable but must be explicitly hedged as vendor/self-reported (real numbers, but commercially interested source, no independent replication):**
- Veracode 45% OWASP-vulnerability figure (C3) — the 45% number is real and vendor-confirmed; the widely-repeated "2.74x" figure could NOT be traced to Veracode's own report in this search and appears to be conflated with a separate CodeRabbit study. Use 45% only, or independently pull Veracode's full PDF before citing 2.74x.
- GitClear's code-duplication rise (C4) — real, vendor-produced, correlational only, AND internally inconsistent: GitClear's own report page TITLE says "4x Growth in Code Clones" while the report BODY and press-mentions page say duplicated blocks "rose eightfold." The paper should cite the specific underlying metric (e.g. "copy-pasted lines rose from 8.3% to 12.3%, moved/refactored lines fell below 10%") rather than asserting a bare "8x" multiplier as settled, or explicitly note both figures.
- Faros AI's "Acceleration Whiplash" PR-review/incident figures (C7) — real, vendor telemetry, cross-sectional not longitudinal.
- Sonar's 96%-don't-trust / 48%-always-verify verification gap (C9) — real, vendor survey, directly supports the M6 (inline verification) mechanism by name.

**Must be corrected or dropped:**
- The "Anthropic 400,000-session study found 17% lower comprehension" claim (C8) conflates two different Anthropic-adjacent studies. The 400K-session study is real but does not measure comprehension; the comprehension-deficit figure belongs to a separate Shen & Tamkin paper that could not be independently pulled in this search. **Do not cite the 400K-session study for the comprehension-deficit number** — cite Shen & Tamkin (2026) directly once verified, or drop the specific 17% figure.
- The JetBrains "77% manually correct AI output for conventions" claim (C10) could not be found anywhere in JetBrains' own materials after multiple targeted searches. **Recommend dropping this figure** unless it can be independently located in JetBrains' raw downloadable dataset.
- The MCP context-bloat claims (C11): the 43%→14% tool-selection-accuracy figures ARE real (RAG-MCP, arXiv) but describe a synthetic stress test comparing a proposed method against a naive baseline — not a general "accuracy degrades as tools accumulate" curve as the field report implies. The 72%-of-context-window figure has no traceable formal source, only recurring blog anecdotes about one individual's MCP setup. **Reframe or drop.**

**Overall calibration for the white paper:** of the twelve claims, two rest on genuinely independent, peer-reviewed or transparently-run research (METR, Panickssery/NeurIPS); one is a strong official primary-source admission (OpenAI's SWE-bench retirement) plus one large transparent multi-stakeholder industry study (DORA); one is a large, disclosed-methodology public survey (Stack Overflow). Five rest on vendor self-reported telemetry/surveys that are real but commercially motivated and not independently replicated (Veracode, GitClear, Faros, Sonar, and the RAG-MCP-adjacent MCP-bloat anecdotes) — and of these, GitClear's own report is additionally internally inconsistent about its headline multiplier (4x vs 8x) and should be cited via its underlying percentages, not a bare multiplier. Two claims as stated in the field report are not supported by verifiable primary sources and should be corrected or removed (the Anthropic-comprehension conflation, and the JetBrains 77% figure).
