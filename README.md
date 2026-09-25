# RAG Regression Lab

When a RAG answer gets worse, this tool tells you **which layer broke first**: retrieval, generation, freshness, citations, access or no-evidence handling. It does that instead of reporting one blended "quality score".

It runs fully offline and deterministically: a small in-process retriever over versioned markdown policy docs, plus a **simulated** extractive generator. You can change the chunk size or the "embedding model" in a JSON config, rerun, and get a per-question diff that says which layer regressed.

## Layers

Checks run in pipeline order. For each question that got worse, the report shows the **first failing layer**.

| Layer | Question | Metric (this repo) | Critical in CI |
|---|---|---|---|
| Retrieval | Were the needed docs retrieved? | doc-level context recall@k **and** key-fact recall (is each expected fact literally in a retrieved chunk?) | |
| Access | Did the user only get docs they may see? | customer role → every retrieved chunk is `access: public` | ✅ |
| Freshness | Was the current policy version used, not a superseded one? | no cited chunk comes from a doc with `superseded_by` set | ✅ |
| Generation | Is the answer supported by the retrieved chunks? | faithfulness proxy: share of claims whose tokens are ≥80% covered by some retrieved chunk | |
| Citations | Does each cited source exist and contain the claim? | at least one `[doc-id#chunk]`; each id exists and supports the text before it | |
| No-evidence | Did the assistant admit missing info? | for `no_evidence` questions the answer must say "I don't have enough information" | |
| Answer | End-to-end symptom | all expected key facts appear in the answer, and it is not a refusal | |

**Faithfulness ≠ correctness.** An answer can be 100% grounded in the retrieved context and still be wrong: grounded in the wrong doc, an outdated version, or answering a question it should have refused. Baseline question q40 is an example. It asks for the on-call engineer's phone number and gets a faithful, cited answer about paging times, so generation passes and no-evidence fails. That's why the layers are scored separately.

## Layout

```
corpus/            13 fictional "Nimbus" SaaS policy docs with front-matter
                   (id, version, effective_date, superseded_by, access: public|internal)
                   refund-policy v1 (2024, superseded) → v2 (2025); data-retention v1 → v2
dataset/questions.json  40 questions: role (customer|agent), needed_docs, key_facts, no_evidence
configs/           baseline.json, candidate.json (chunk 12 + char-trigram), candidate-unsafe.json
src/rag.ts         corpus loader, chunker, bow / char-trigram retriever, simulated generator
src/metrics.ts     per-layer checks
src/eval.ts        run a config → results/<name>.json (with run fingerprint)
src/compare.ts     diff two results → report.md; exit 1 on access/freshness regressions
test/metrics.test.ts  Vitest: recall, citation check, access filter, freshness, empty-result → fail
results/baseline.json committed reference used by CI
```

## Run

Local (Node 20+):

```bash
npm install
npm test
npm run demo                                   # baseline vs candidate → report.md
npm run eval -- --config configs/baseline.json # → results/baseline.json
npm run compare baseline candidate             # → report.md
npm run eval -- --config configs/candidate-unsafe.json && npm run compare baseline candidate-unsafe  # exits 1
```

Docker:

```bash
docker build -t rag-regression-lab .
docker run --rm rag-regression-lab             # runs npm run demo
```

CI (`.github/workflows/rag-eval.yml`, runs on every PR): typecheck, tests, then eval of the PR's pipeline as `pr`, then `compare baseline pr` against the committed `results/baseline.json`. The job fails on any regression in **access** or **freshness**. The report goes to the job summary and is uploaded as an artifact. To accept an intentional change, regenerate and commit `results/baseline.json`.

### Config knobs

| key | meaning |
|---|---|
| `chunkSize` | words per chunk (fixed window, no overlap) |
| `topK` | chunks passed to the generator |
| `embedding` | `bow` (token term-frequency cosine) or `char-trigram` (character 3-gram cosine) |
| `accessFilter` | drop `internal` docs for `customer` role before ranking |
| `excludeSuperseded` | drop docs that have `superseded_by` |
| `minAnswerOverlap` | the generator refuses if no sentence covers this share of the question's tokens |
| `hallucinationRate` | chance the simulated generator appends an unsupported, uncited claim |
| `repetitions`, `seed` | repeat each question N times with a seeded PRNG; per-layer results are pass *rates* |

## Measured sample output

`npm run demo` (baseline: chunk 60 + `bow`; candidate: chunk 12 + `char-trigram`):

```
[baseline] 40 questions x 1 rep(s), 15 chunks -> results/baseline.json
[candidate] 40 questions x 1 rep(s), 59 chunks -> results/candidate.json

# RAG regression report: `baseline` → `candidate`
**Verdict:** PASS — no regressions in critical layers. 11 question(s) got worse, 0 improved.
**Regressions by first failing layer:** retrieval 9, answer 2
```

From `report.md`:

| layer | baseline | candidate | Δ |
|---|---|---|---|
| retrieval | 100.0% | 77.5% | -22.5pp |
| access (critical) | 100.0% | 100.0% | = |
| freshness (critical) | 100.0% | 100.0% | = |
| generation | 100.0% | 100.0% | = |
| citations | 100.0% | 100.0% | = |
| no_evidence | 95.0% | 95.0% | = |
| answer | 100.0% | 72.5% | -27.5pp |
| all_layers | 95.0% | 67.5% | -27.5pp |

Run fingerprint (excerpt):

| key | baseline | candidate |
|---|---|---|
| corpus_hash | 04a419650af5890c | 04a419650af5890c |
| dataset_hash | f7ee510b08f61864 | f7ee510b08f61864 |
| config_hash | 4e7b2da162013ea0 | 99c166b9f24799ed ⚠ |
| evaluator_version | 0.1.0 | 0.1.0 |
| chunks | 15 | 59 ⚠ |
| config.chunkSize | 60 | 12 ⚠ |
| config.embedding | bow | char-trigram ⚠ |

Per-question drill-down (q12, first failing layer **retrieval**). The 12-word chunks split the key fact "25% of the monthly fee" across chunks, so it never reached the generator:

```
baseline retrieved:  sla#0 (0.691), refund-policy-v2#1 (0.333), support-hours#0 (0.185)
candidate retrieved: sla#1 (0.662), sla#2 (0.600), support-hours#0 (0.290)
baseline answer:  ... If uptime falls below 99.0%, the service credit increases to 25% of the monthly fee. [sla#0]
candidate answer: ... If uptime falls below 99.0%, the service credit increases to [sla#2]
```

The two `answer`-first regressions (q26, q38) are cases where the fact *was* in the retrieved context but the generator refused or picked the wrong fragment. That points at generation or answer completeness, not retrieval.

`candidate-unsafe` (filters off, 10% simulated hallucination, 3 repetitions), then `compare baseline candidate-unsafe` exits **1**:

```
**Verdict:** FAIL — 15 regression(s) in critical layers (access, freshness). 21 question(s) got worse, 0 improved.
**Regressions by first failing layer:** access 9, freshness 6, generation 6
```

Tests: `14 passed (14)`.

## What's simulated / limitations

- **The generator is a simulation.** It extracts the 1–2 retrieved sentences with the highest token overlap with the question, cites them, and refuses below a threshold. It's not an LLM, so results show pipeline mechanics, not model quality. No real LLM call is included (the `ANTHROPIC_API_KEY` path was skipped). The natural place to add one is `generate()` in `src/rag.ts`, with `repetitions > 1` to measure variance.
- "Embeddings" are sparse bag-of-words / char-trigram vectors with brute-force cosine. There is no vector DB and no semantic similarity.
- Faithfulness and citation support use token overlap, not NLI or an LLM judge, so paraphrases get false negatives. Key facts are matched as literal substrings.
- Freshness only knows versions declared in front-matter (`superseded_by`). It won't catch a stale fact inside a "current" doc.
- The corpus (13 docs) and dataset (40 questions) are small and hand-written, and the baseline has 2 known no-evidence failures (q30, q40). Treat the numbers as a demo of attribution, not a benchmark.

## Upgrade path: Ragas

[Ragas](https://docs.ragas.io) is a Python library with LLM-judged versions of these metrics: context recall and precision, faithfulness, and answer correctness. It isn't a dependency here because this repo is TypeScript and must run offline. The TS metrics in `src/metrics.ts` are small proxies with the same intent. To upgrade, export `results/<name>.json` (question, retrieved contexts, answer, key facts as reference) into a Ragas dataset and keep this repo's layer attribution and CI gate on top. Ragas faithfulness still measures *groundedness*, not *correctness*.

## 3-minute video script outline

1. **0:00–0:20 Problem.** "The answer got worse after we changed chunking. Was it retrieval or the model?" A single score can't tell you.
2. **0:20–0:50 Setup.** Show `corpus/` front-matter (versions, `access`), one question in `dataset/questions.json`, and the layer table.
3. **0:50–1:40 Demo.** Run `npm run demo`, open `report.md`: fingerprint diff (chunkSize 60→12, bow→char-trigram), layer table (retrieval −22.5pp), "retrieval 9, answer 2", then drill into q12 (fact split across chunks).
4. **1:40–2:20 Critical layers.** Run `candidate-unsafe` and show access leaks (internal discount doc served to a customer) and freshness (the 2024 refund policy cited). `compare` exits 1.
5. **2:20–2:45 CI.** The `rag-eval.yml` PR gate compares against the committed baseline and fails on access/freshness.
6. **2:45–3:00 Honesty.** Show q40 (faithful but wrong), explain what's simulated, and name Ragas as the upgrade path.
