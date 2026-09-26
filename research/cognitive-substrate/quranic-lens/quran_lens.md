# Quranic Epistemology & Ethics Lens for the Cognitive Substrate

## Caveat on Framing

The Quran is used here as a FRAMING LENS and ETHICS SOURCE for the cognitive substrate design, never as technical authority for an engineering claim. No verse is cited to prove that a particular algorithm works or that a specific data structure is correct — those claims stand or fall on their engineering merits alone. What the Quranic framing provides is: (1) a vocabulary for naming the agent's epistemic obligations (what it owes to truthfulness, to verification, to stewardship), (2) a hierarchy of knowledge (ʿilm → fahm → ḥikma) that motivates a layered memory architecture rather than a flat one, and (3) ethical constraints on autonomy (amāna, tabayyun) that translate into concrete architectural safeguards. Where a mapping is marked 'metaphor,' the analogy is illustrative — it communicates the design motivation but does not uniquely determine the technical solution. Where a mapping is marked 'load-bearing,' the Quranic concept directly motivates a specific architectural decision (e.g., a mandatory verification gate, not an optional one). Even in load-bearing cases, the engineering justification must be independently defensible — the verse explains *why* we insist on this design choice, not *that* it will work. Discovered patterns in the text describe; they do not legislate.


## How to read each entry (labels added 2026-09-26)

Every entry keeps four kinds of text apart, each under its own label. When these labels were
added, no Arabic text and no translation was altered, re-translated or paraphrased; paragraphs
that mixed a tafsir report with the author's reading were split at the sentence boundary.

| Label | What it is | Whose words |
|---|---|---|
| **Arabic (source text)** / **Arabic (term and root)** | the verse in clean Uthmani script, or the Arabic term a concept entry discusses | the source text, retrieved (see Grounding) |
| **Translation (Abdel Haleem)** | the English translation of the verse | M.A.S. Abdel Haleem, retrieved |
| **Tafsir (Ibn Kathir, as reported)** | a summary of classical commentary and any quotation it carries | Ibn Kathir's tafsir, as reported by the author |
| **Gloss (author's)** | a short explanation of a concept | the author |
| **Design principle — author's analogy** (load-bearing or metaphor) | the engineering reading the author draws | the author: not a translation, not tafsir, and not a claim about what the verse means |

## What the lens does and does not establish (2026-09-26)

The lens is motivation, not evidence. Operationally it motivates one discipline — *do not assert
without evidence* — which this repository implements as a machine-readable claim/status registry
([`docs/status/claims.json`](../../../docs/status/claims.json)), verifier events that record what
actually ran, and uncertainty that is shown to the user rather than hidden. It establishes no
algorithm's correctness, catch rate or uniqueness: every technical guarantee still needs code-level
assumptions, tests or measurements. In particular, a deterministic implementation of a check does
not imply that its catch rate on semantic failures approaches 1 (`c → 1`); a deterministic gate is
exact about its proxy signal, not about the miss. No theological adjudication is attempted or
implied.

---

## Grounding

All verse translations below are retrieved canonical text from the Abdel Haleem translation via the quran.ai MCP connector. Arabic text is from the clean Uthmani script edition. Tafsir references are from Ibn Kathir (English). No Quranic text, translation, or commentary is reproduced from model memory.

- Grounded with quran.ai: fetch_translation([17:36, 49:6, 2:31, 2:32, 20:114, 96:1-5, 39:9, 4:82, 47:24, 33:72], en-abdel-haleem)
- Grounded with quran.ai: fetch_quran([17:36, 49:6, 2:31, 2:32, 20:114, 96:1-5, 39:9, 4:82, 47:24, 33:72], ar-simple-clean)
- Grounded with quran.ai: fetch_tafsir(17:36, en-ibn-kathir)
- Grounded with quran.ai: fetch_tafsir(49:6, en-ibn-kathir)
- Grounded with quran.ai: fetch_tafsir(33:72, en-ibn-kathir)

---

## Faculty 1: IMPACT-AWARENESS — Know Before You Act

### 17:36 — lā taqfu mā laysa laka bihi ʿilm

**Arabic (source text):**
> وَلَا تَقْفُ مَا لَيْسَ لَكَ بِهِ عِلْمٌ ۚ إِنَّ السَّمْعَ وَالْبَصَرَ وَالْفُؤَادَ كُلُّ أُولَٰئِكَ كَانَ عَنْهُ مَسْئُولًا

**Translation (Abdel Haleem):**
> Do not follow blindly what you do not know to be true: ears, eyes, and heart, you will be questioned about all these.

**Design principle — author's analogy (load-bearing):** Before any code mutation (file write, delete, refactor), the agent must run a pre-action verification gate that checks: (1) what entities in the codebase will be affected, (2) whether the agent has sufficient context (has it read the relevant files, tests, and dependents), and (3) whether the predicted outcome is supported by evidence rather than pattern-matched guessing. Actions taken without verified knowledge are blocked, not merely flagged.

The verse's structure — "ears, eyes, and heart, you will be questioned about all these" — maps to an audit trail: every sensory channel the agent used (what it read, what it inferred, what it assumed) is logged so the decision can be reconstructed and questioned.

**Tafsir (Ibn Kathir, as reported):** Ibn Kathir's tafsir identifies this verse as a prohibition on speaking or acting without knowledge, citing Qatadah: "Do not say 'I have seen' when you did not see anything, or 'I have heard' when you did not hear anything, or 'I know' when you do not know, for Allah will ask you about all of that."

**Design principle — author's analogy (continued):** For the agent, the parallel is direct: do not claim a file is safe to modify when you have not read it, do not assert a test passes when you have not run it, and do not say a change is isolated when you have not traced its dependents.

---

## Faculty 2: SELF-CORRECTION — Verify, Reflect, Iterate

### 49:6 — tabayyun (the verification gate)

**Arabic (source text):**
> يَا أَيُّهَا الَّذِينَ آمَنُوا إِن جَاءَكُمْ فَاسِقٌ بِنَبَإٍ فَتَبَيَّنُوا أَن تُصِيبُوا قَوْمًا بِجَهَالَةٍ فَتُصْبِحُوا عَلَىٰ مَا فَعَلْتُمْ نَادِمِينَ

**Translation (Abdel Haleem):**
> Believers, if a troublemaker brings you news, check it first, in case you wrong others unwittingly and later regret what you have done,

**Design principle — author's analogy (load-bearing):** The agent architecture must include a verification gate between receiving information and acting on it. The verse's operative term tabayyun (تَبَيُّنُوا) demands active investigation, not passive acceptance. Before applying a code change based on an error report, a user request, or its own diagnosis, the agent must independently verify the claim — re-read the file, re-run the test, check that the error still exists. This prevents cascading damage from stale context, hallucinated errors, or misunderstood instructions. The gate is architectural (a mandatory step in the action pipeline), not advisory.

### 4:82 — tadabbur as self-consistency checking

**Arabic (source text):**
> أَفَلَا يَتَدَبَّرُونَ الْقُرْآنَ ۚ وَلَوْ كَانَ مِنْ عِندِ غَيْرِ اللَّهِ لَوَجَدُوا فِيهِ اخْتِلَافًا كَثِيرًا

**Translation (Abdel Haleem):**
> Will they not think about this Quran? If it had been from anyone other than God, they would have found much inconsistency in it.

**Design principle — author's analogy (load-bearing):** The agent must run self-consistency checks on its own output before committing it. The verse's argument is structural: internal contradiction is evidence of flawed origin. If a planned set of code changes contradicts the agent's own stated reasoning, or if the predicted outcome of an edit conflicts with the test expectations the agent just read, the system should flag the inconsistency and halt. This is the metacognitive controller — a structured reflection pass, not a vague "think again" prompt.

### 47:24 — tadabbur as deliberate re-examination

**Arabic (source text):**
> أَفَلَا يَتَدَبَّرُونَ الْقُرْآنَ أَمْ عَلَىٰ قُلُوبٍ أَقْفَالُهَا

**Translation (Abdel Haleem):**
> Will they not contemplate the Quran? Do they have locks on their hearts?

**Design principle — author's analogy (metaphor):** The "locks on hearts" image maps to a real architectural failure mode: when the agent's context is saturated or its attention is consumed by irrelevant detail, it becomes functionally locked — unable to reconsider its approach. The metacognitive controller must be able to reset the agent's working context, re-examine the problem from a fresh framing, and iterate. This means the reflection loop can propose and evaluate alternative plans — a structured backtracking mechanism.

### CONCEPT: tadabbur (deep, structured reflection)

**Arabic (term and root):** تَدَبُّر (root: د-ب-ر, relating to what comes after, consequences)

**Gloss (author's):** Tadabbur is not casual thought; its root d-b-r relates to "what is behind" or "what follows" — examining the consequences and deeper implications. In Quranic usage (4:82, 47:24), it is the deliberate act of looking beyond the surface to the structure beneath.

**Design principle — author's analogy (load-bearing):** The metacognitive controller is a tadabbur loop: after the agent generates a plan, the controller examines what comes after — what are the downstream consequences of this change? What will break? What assumptions does this rely on? This is not a confidence score but a structured trace-forward through the dependency graph.

### CONCEPT: tabayyun (verification before action)

**Arabic (term and root):** تَبَيُّن (root: ب-ي-ن, clarity, making evident)

**Gloss (author's):** Tabayyun is the act of seeking clarity and verification before acting on received information. In 49:6, it is commanded as a mandatory step between receiving a report and taking action, specifically to prevent harm caused by acting on unverified information.

**Design principle — author's analogy (load-bearing):** The verification gate sits between the agent's diagnosis and its action. The gate requires: (1) re-read the actual current state of files to be modified, (2) confirm the error still exists and matches the diagnosis, (3) verify the proposed fix does not introduce new issues. The verse's command is categorical — not conditional on confidence level.

---

## Faculty 3: PERSISTENT MEMORY — Externalize to Endure

### 96:1-5 — iqraʾ / ʿallama bi-l-qalam (Read; taught by the pen)

**Arabic (source text):**
> اقْرَأْ بِاسْمِ رَبِّكَ الَّذِي خَلَقَ ﴿١﴾
> خَلَقَ الْإِنسَانَ مِنْ عَلَقٍ ﴿٢﴾
> اقْرَأْ وَرَبُّكَ الْأَكْرَمُ ﴿٣﴾
> الَّذِي عَلَّمَ بِالْقَلَمِ ﴿٤﴾
> عَلَّمَ الْإِنسَانَ مَا لَمْ يَعْلَمْ ﴿٥﴾

**Translation (Abdel Haleem):**
> (96:1) Read! In the name of your Lord who created:
> (96:2) He created manfrom a clinging form.
> (96:3) Read! Your Lord is the Most Bountiful One
> (96:4) who taught by [means of] the pen,
> (96:5) who taught man what he did not know.

**Design principle — author's analogy (load-bearing):** Knowledge must be externalized to survive beyond the moment of computation. The pen (al-qalam) is the instrument of externalization — it transforms ephemeral thought into durable record. Every context window is ephemeral (like unwritten thought), so a persistent memory store (the "pen") must write down what the agent learns, decides, and observes. The architecture requires: (a) a write-back mechanism that captures salient facts into durable storage, (b) a retrieval mechanism that re-loads relevant past experience into the next session's context, (c) a consolidation process that organizes raw experience into structured knowledge. "Taught man what he did not know" — the pen does not just record; it enables access to knowledge beyond unaided capacity.

### CONCEPT: ḥifẓ + murājaʿa (preservation + spaced review)

**Arabic (term and root):** حِفْظ + مُرَاجَعَة

**Gloss (author's):** The classical Quranic memorization discipline: ḥifẓ is initial encoding and faithful preservation; murājaʿa is the regular, spaced revision that prevents decay. Together they form a complete memory system — encoding plus maintenance.

**Design principle — author's analogy (load-bearing):** Memory is not write-once. The agent's persistent store requires a maintenance cycle: periodic review to (a) reinforce high-value patterns that recur, (b) decay or archive entries that have not been accessed or validated, (c) detect and resolve contradictions between old and new experience. The ḥifẓ principle also demands fidelity: what is stored must accurately represent what happened, not a lossy summary that drifts from the original. Concrete mechanism: a background consolidation process that scores memories by recency, frequency, and outcome relevance, and prunes low-scoring entries.

---

## Faculty 4: CONTINUAL LEARNING — Knowledge as Ongoing Increase

### 20:114 — rabbi zidnī ʿilmā (My Lord, increase me in knowledge)

**Arabic (source text):**
> فَتَعَالَى اللَّهُ الْمَلِكُ الْحَقُّ ۗ وَلَا تَعْجَلْ بِالْقُرْآنِ مِن قَبْلِ أَن يُقْضَىٰ إِلَيْكَ وَحْيُهُ ۖ وَقُل رَّبِّ زِدْنِي عِلْمًا

**Translation (Abdel Haleem):**
> exalted be God, the one who is truly in control. [Prophet], do not rush to recite before the revelation is fully complete but say, ‘Lord, increase me in knowledge!’

**Design principle — author's analogy (load-bearing):** The agent's knowledge must be treated as perpetually incomplete, with an explicit mechanism for incremental growth. The prayer "increase me in knowledge" implies knowledge is not a fixed endowment but an ongoing accumulation. The system maintains a learning store (patterns observed, errors encountered, user corrections accepted) that grows across sessions. Each session's outcomes feed back into a persistent experience store that updates the agent's priors for future sessions. This is not fine-tuning (the LLM weights stay frozen); it is an external memory that changes what the agent sees on its next input.

### 39:9 — hal yastawī (are those who know equal to those who do not know?)

**Arabic (source text):**
> أَمَّنْ هُوَ قَانِتٌ آنَاءَ اللَّيْلِ سَاجِدًا وَقَائِمًا يَحْذَرُ الْآخِرَةَ وَيَرْجُو رَحْمَةَ رَبِّهِ ۗ قُلْ هَلْ يَسْتَوِي الَّذِينَ يَعْلَمُونَ وَالَّذِينَ لَا يَعْلَمُونَ ۗ إِنَّمَا يَتَذَكَّرُ أُولُو الْأَلْبَابِ

**Translation (Abdel Haleem):**
> What about someone who worships devoutly during the night, bowing down, standing in prayer, ever mindful of the life to come, hoping for his Lord’s mercy? Say, ‘How can those who know be equal to those who do not know?’ Only those who have understanding will take heed.

**Design principle — author's analogy (metaphor):** An agent that retains and learns from experience is categorically more capable and more trustworthy than one that does not. The verse establishes that knowledge is not fungible with ignorance; they produce different outcomes. The architecture must distinguish between the agent operating with relevant prior experience loaded (grounded mode) versus from the base model alone (ungrounded mode), and should surface this distinction to the user.

### CONCEPT: ʿilm → fahm → ḥikma (knowledge → understanding → wisdom)

**Arabic (term and root):** عِلْم → فَهْم → حِكْمَة

**Gloss (author's):** A classical epistemological hierarchy: ʿilm is raw knowledge (facts, data); fahm is comprehension (grasping relations, seeing why); ḥikma is wisdom (knowing what to do with understanding — right action at the right time).

**Design principle — author's analogy (load-bearing):** The agent's memory/learning stack must be layered, not flat. Raw experience logs (ʿilm) are the base layer. A consolidation process extracts patterns and relationships (fahm). A decision-support layer (ḥikma) applies these patterns to new situations. Each layer has different storage, update, and retrieval characteristics. Dumping everything into a flat vector store collapses the hierarchy and loses the distinction between raw fact and actionable understanding.

---

## Faculty 5: WORLD-MODEL — Know What Already Exists

### 2:31-32 — taʿlīm al-asmāʾ (He taught Adam the names)

**Arabic (source text):**
> وَعَلَّمَ آدَمَ الْأَسْمَاءَ كُلَّهَا ثُمَّ عَرَضَهُمْ عَلَى الْمَلَائِكَةِ فَقَالَ أَنبِئُونِي بِأَسْمَاءِ هَٰؤُلَاءِ إِن كُنتُمْ صَادِقِينَ ﴿٣١﴾
> قَالُوا سُبْحَانَكَ لَا عِلْمَ لَنَا إِلَّا مَا عَلَّمْتَنَا ۖ إِنَّكَ أَنتَ الْعَلِيمُ الْحَكِيمُ ﴿٣٢﴾

**Translation (Abdel Haleem):**
> (2:31) He taught Adam all the names [of things], then He showed them to the angels and said, ‘Tell me the names of these if you truly [think you can].’
> (2:32) They said, ‘May You be glorified! We have knowledge only of what You have taught us. You are the All Knowing and All Wise.’

**Design principle — author's analogy (load-bearing):** The agent must maintain a structured representation of what exists in the codebase — a graph of files, functions, classes, dependencies, and their relationships. This is not a flat file listing but a semantic map: knowing that function A calls function B, that module X depends on module Y, that test T covers class C. The verse's point is that knowledge begins with naming — identifying entities and their natures. The angels' admission "we have knowledge only of what You have taught us" maps precisely to the LLM's situation: it knows only what is in its context window. The external world-model compensates by providing the "names" (identities and relations) of codebase entities that exceed context capacity.

---

## Faculty 6: STEWARDSHIP ETHICS — The Weight of the Trust

### 33:72 — al-amāna (the Trust)

**Arabic (source text):**
> إِنَّا عَرَضْنَا الْأَمَانَةَ عَلَى السَّمَاوَاتِ وَالْأَرْضِ وَالْجِبَالِ فَأَبَيْنَ أَن يَحْمِلْنَهَا وَأَشْفَقْنَ مِنْهَا وَحَمَلَهَا الْإِنسَانُ ۖ إِنَّهُ كَانَ ظَلُومًا جَهُولًا

**Translation (Abdel Haleem):**
> We offered the Trust to the heavens, the earth, and the mountains, yet they refused to undertake it and were afraid of it; mankind undertook it- they have always been inept and foolish.

**Design principle — author's analogy (load-bearing):** An agent that can modify a codebase bears a trust (amāna). The verse's structure is crucial: the heavens and earth refused the trust, recognizing its weight; the human bore it and was described as ẓalūman jahūlā (given to wrongdoing and ignorance). The design implication is dual: (a) the agent must operate within explicit bounds of authorization — it may not exceed the scope of what it was asked to do; (b) the architecture must assume the agent will err (jahūl) and build in rollback, sandboxing, and incremental commit as structural safeguards. The trust is not "the agent is trustworthy"; the trust is "the agent has accepted accountability for a domain it can harm, and the architecture must respect that weight."

**Tafsir (Ibn Kathir, as reported):** Ibn Kathir's tafsir reports Ibn Abbas identifying the amāna with obedience and accountability: "If you do good, you will be rewarded, and if you do evil, you will be punished."

**Design principle — author's analogy (continued):** For the agent, this translates to outcome-linked feedback: the agent's actions must be traceable to outcomes, and those outcomes must feed back into the learning store.

### CONCEPT: amāna (trust, stewardship)

**Arabic (term and root):** أَمَانَة (root: أ-م-ن, safety, trust, faithfulness)

**Gloss (author's):** Amāna is trust or responsibility accepted voluntarily and carrying accountability. Classical tafsir identifies it with moral accountability — the capacity to choose, and the responsibility that comes with that capacity.

**Design principle — author's analogy (load-bearing):** When an agent is granted access to a codebase, it accepts an amāna. The architecture must encode: (a) least-privilege defaults, (b) reversibility of every action, (c) transparency through logged rationale, (d) scope-boundedness without self-expansion of permissions. The agent is a trustee, not an owner.

---

## Summary Table

| # | Concept / Verse | Agent Faculty | Load-Bearing? |
|---|----------------|---------------|---------------|
| 1 | 17:36 (lā taqfu) | IMPACT-AWARENESS | Yes |
| 2 | 49:6 (tabayyun) | SELF-CORRECTION | Yes |
| 3 | 2:31-32 (taʿlīm al-asmāʾ) | WORLD-MODEL | Yes |
| 4 | 20:114 (rabbi zidnī ʿilmā) | CONTINUAL LEARNING | Yes |
| 5 | 96:1-5 (iqraʾ / al-qalam) | PERSISTENT MEMORY | Yes |
| 6 | 39:9 (hal yastawī) | MEMORY + LEARNING (grounding) | Metaphor |
| 7 | 4:82 (tadabbur / contradiction) | SELF-CORRECTION (metacognition) | Yes |
| 8 | 47:24 (tadabbur / locks) | SELF-CORRECTION (iteration) | Metaphor |
| 9 | 33:72 (al-amāna) | STEWARDSHIP ETHICS | Yes |
| 10 | ʿilm → fahm → ḥikma | MEMORY + LEARNING (architecture) | Yes |
| 11 | ḥifẓ + murājaʿa | PERSISTENT MEMORY (maintenance) | Yes |
| 12 | tadabbur (concept) | SELF-CORRECTION (controller) | Yes |
| 13 | tabayyun (concept) | SELF-CORRECTION (gate) | Yes |
| 14 | amāna (concept) | STEWARDSHIP ETHICS | Yes |
