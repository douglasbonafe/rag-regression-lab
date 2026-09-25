// npm run eval -- --config configs/baseline.json [--name pr]  ->  results/<name>.json
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { Config, chunkDocs, generate, loadCorpus, mulberry32, retrieve } from './rag.ts';
import { LAYERS, type Layer, accessOk, answerOk, citationsOk, contextRecall, factRecall, faithfulness, freshnessOk, isRefusal } from './metrics.ts';

const Question = z.object({
  id: z.string(),
  role: z.enum(['customer', 'agent']),
  question: z.string(),
  needed_docs: z.array(z.string()),
  key_facts: z.array(z.string()),
  no_evidence: z.boolean(),
});

const { values } = parseArgs({ options: { config: { type: 'string' }, name: { type: 'string' } } });
if (!values.config) throw new Error('usage: npm run eval -- --config configs/<name>.json [--name <out>]');

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const cfg = Config.parse(JSON.parse(readFileSync(values.config, 'utf8')));
const name = values.name ?? cfg.name;
const { docs, hash: corpusHash } = loadCorpus();
const datasetRaw = readFileSync('dataset/questions.json', 'utf8');
const questions = z.array(Question).parse(JSON.parse(datasetRaw));
const docIds = new Set(docs.map((d) => d.id));
for (const q of questions) for (const d of q.needed_docs) if (!docIds.has(d)) throw new Error(`${q.id}: unknown doc ${d}`);

const chunks = chunkDocs(docs, cfg.chunkSize);
const byId = new Map(chunks.map((c) => [c.id, c]));
const rand = mulberry32(cfg.seed);

const results = questions.map((q) => {
  const runs = Array.from({ length: cfg.repetitions }, () => {
    const ctx = retrieve(q.question, chunks, q.role, cfg);
    const answer = generate(q.question, ctx, cfg, rand);
    const scores = {
      context_recall: contextRecall(q.needed_docs, ctx),
      fact_recall: factRecall(q.key_facts, ctx),
      faithfulness: faithfulness(answer, ctx),
    };
    const layers: Record<Layer, boolean> = {
      retrieval: scores.context_recall === 1 && scores.fact_recall === 1,
      access: accessOk(q.role, ctx),
      freshness: freshnessOk(answer, byId),
      generation: scores.faithfulness === 1,
      citations: citationsOk(answer, byId),
      no_evidence: q.no_evidence ? isRefusal(answer) : true,
      answer: q.no_evidence || answerOk(answer, q.key_facts),
    };
    return { retrieved: ctx.map((c) => `${c.id} (${c.score.toFixed(3)})`), answer, scores, layers };
  });
  const pass_rate = Object.fromEntries(LAYERS.map((l) => [l, runs.filter((r) => r.layers[l]).length / runs.length])) as Record<Layer, number>;
  return { id: q.id, role: q.role, question: q.question, pass_rate, sample: runs[0] };
});

const mean = (xs: number[]) => Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000;
const summary = {
  ...Object.fromEntries(LAYERS.map((l) => [l, mean(results.map((r) => r.pass_rate[l]))])),
  all_layers: mean(results.map((r) => (LAYERS.every((l) => r.pass_rate[l] === 1) ? 1 : 0))),
};
const fingerprint = {
  corpus_hash: corpusHash,
  dataset_hash: sha(datasetRaw),
  config_hash: sha(JSON.stringify(cfg)),
  evaluator_version: JSON.parse(readFileSync('package.json', 'utf8')).version,
  generator: 'simulated-extractive',
  chunks: chunks.length,
  questions: questions.length,
};

mkdirSync('results', { recursive: true });
writeFileSync(`results/${name}.json`, JSON.stringify({ name, fingerprint, config: cfg, summary, questions: results }, null, 2) + '\n');
console.log(`[${name}] ${questions.length} questions x ${cfg.repetitions} rep(s), ${chunks.length} chunks -> results/${name}.json`);
console.table(summary);
