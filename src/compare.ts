// npm run compare -- <baseline> <candidate>  ->  report.md ; exit 1 on critical-layer regressions
import { readFileSync, writeFileSync } from 'node:fs';
import { CRITICAL, LAYERS, type Layer } from './metrics.ts';

type Q = { id: string; role: string; question: string; pass_rate: Record<Layer, number>; sample: { retrieved: string[]; answer: string } };
type Run = { name: string; fingerprint: Record<string, string | number>; config: Record<string, unknown>; summary: Record<string, number>; questions: Q[] };

const [baseName, candName] = process.argv.slice(2);
if (!baseName || !candName) throw new Error('usage: npm run compare -- <baseline> <candidate>');
const load = (n: string): Run => JSON.parse(readFileSync(`results/${n}.json`, 'utf8'));
const base = load(baseName);
const cand = load(candName);
const baseQ = new Map(base.questions.map((q) => [q.id, q]));

const regressions = cand.questions.flatMap((c) => {
  const b = baseQ.get(c.id);
  if (!b) return [];
  const regressed = LAYERS.filter((l) => c.pass_rate[l] < b.pass_rate[l]);
  if (!regressed.length) return [];
  const firstFailed = LAYERS.find((l) => c.pass_rate[l] < 1)!;
  return [{ b, c, regressed, firstFailed }];
});
const improved = cand.questions.filter((c) => {
  const b = baseQ.get(c.id);
  return b && LAYERS.some((l) => c.pass_rate[l] > b.pass_rate[l]);
});
const critical = regressions.filter((r) => r.regressed.some((l) => CRITICAL.includes(l)));
const byLayer = LAYERS.map((l) => [l, regressions.filter((r) => r.firstFailed === l).length] as const).filter(([, n]) => n);

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const cut = (s: string, n = 180) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\|/g, '\\|');
const fpKeys = [...new Set([...Object.keys(base.fingerprint), ...Object.keys(cand.fingerprint)])];
const cfgKeys = [...new Set([...Object.keys(base.config), ...Object.keys(cand.config)])].filter((k) => k !== 'name');
const warn = ['corpus_hash', 'dataset_hash', 'evaluator_version'].filter((k) => base.fingerprint[k] !== cand.fingerprint[k]);

const md = [
  `# RAG regression report: \`${base.name}\` → \`${cand.name}\``,
  '',
  `**Verdict:** ${critical.length ? `FAIL — ${critical.length} regression(s) in critical layers (${CRITICAL.join(', ')})` : 'PASS — no regressions in critical layers'}. ` +
    `${regressions.length} question(s) got worse, ${improved.length} improved.`,
  '',
  regressions.length ? `**Regressions by first failing layer:** ${byLayer.map(([l, n]) => `${l} ${n}`).join(', ')}` : '',
  '',
  '## Run fingerprint',
  '',
  `| key | ${base.name} | ${cand.name} |`,
  '|---|---|---|',
  ...fpKeys.map((k) => `| ${k} | ${base.fingerprint[k]} | ${cand.fingerprint[k]}${base.fingerprint[k] !== cand.fingerprint[k] ? ' ⚠' : ''} |`),
  ...cfgKeys.map((k) => `| config.${k} | ${base.config[k]} | ${cand.config[k]}${base.config[k] !== cand.config[k] ? ' ⚠' : ''} |`),
  '',
  warn.length ? `> ⚠ ${warn.join(', ')} differ: results are not a like-for-like comparison of the pipeline alone.\n` : '',
  '## Layer pass rates',
  '',
  `| layer | ${base.name} | ${cand.name} | Δ |`,
  '|---|---|---|---|',
  ...[...LAYERS, 'all_layers'].map((l) => {
    const d = cand.summary[l] - base.summary[l];
    return `| ${l}${CRITICAL.includes(l as Layer) ? ' (critical)' : ''} | ${pct(base.summary[l])} | ${pct(cand.summary[l])} | ${d ? `${d > 0 ? '+' : ''}${(d * 100).toFixed(1)}pp` : '='} |`;
  }),
  '',
  `## Questions that got worse (${regressions.length})`,
  '',
  '| id | role | first failing layer | regressed layers | question |',
  '|---|---|---|---|---|',
  ...regressions.map((r) => `| ${r.c.id} | ${r.c.role} | **${r.firstFailed}** | ${r.regressed.join(', ')} | ${cut(r.c.question)} |`),
  '',
  ...regressions.flatMap((r) => [
    `### ${r.c.id} — ${r.firstFailed}`,
    '',
    `- **${base.name} retrieved:** ${r.b.sample.retrieved.join(', ') || '(nothing)'}`,
    `- **${cand.name} retrieved:** ${r.c.sample.retrieved.join(', ') || '(nothing)'}`,
    `- **${base.name} answer:** ${cut(r.b.sample.answer, 300)}`,
    `- **${cand.name} answer:** ${cut(r.c.sample.answer, 300)}`,
    '',
  ]),
  improved.length ? `## Improved\n\n${improved.map((q) => q.id).join(', ')}\n` : '',
].join('\n');

writeFileSync('report.md', md);
console.log(md.split('## Run fingerprint')[0].trim());
console.log(`\nfull report -> report.md`);
if (critical.length) process.exitCode = 1;
