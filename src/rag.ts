// Corpus loading, chunking, retrieval and the SIMULATED generator. No LLM, no vector DB.
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';

export const Config = z.object({
  name: z.string(),
  chunkSize: z.number().int().positive(), // words per chunk
  topK: z.number().int().positive(),
  embedding: z.enum(['bow', 'char-trigram']),
  accessFilter: z.boolean().default(true),
  excludeSuperseded: z.boolean().default(true),
  minAnswerOverlap: z.number().min(0).max(1).default(0.5), // below this the generator refuses
  hallucinationRate: z.number().min(0).max(1).default(0), // simulated generation noise
  repetitions: z.number().int().positive().default(1),
  seed: z.number().int().default(42),
});
export type Config = z.infer<typeof Config>;
export type Role = 'customer' | 'agent';

const DocMeta = z.object({
  id: z.string(),
  version: z.coerce.number(),
  effective_date: z.string(),
  superseded_by: z.string().nullable(),
  access: z.enum(['public', 'internal']),
});
export type Doc = z.infer<typeof DocMeta> & { body: string };
export type Chunk = { id: string; docId: string; text: string; access: Doc['access']; superseded: boolean };
export type Hit = Chunk & { score: number };

export function parseDoc(raw: string): Doc {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error('missing front-matter');
  // ponytail: flat `key: value` front-matter only; swap for a YAML parser if docs need nesting
  const meta = Object.fromEntries(
    m[1].split('\n').map((l) => {
      const i = l.indexOf(':');
      const v = l.slice(i + 1).trim();
      return [l.slice(0, i).trim(), v === '' || v === 'null' ? null : v];
    }),
  );
  return { ...DocMeta.parse(meta), body: m[2] };
}

export function loadCorpus(dir = 'corpus') {
  const hash = createHash('sha256');
  const docs = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => {
      const raw = readFileSync(join(dir, f), 'utf8');
      hash.update(f).update(raw);
      return parseDoc(raw);
    });
  return { docs, hash: hash.digest('hex').slice(0, 16) };
}

// ponytail: fixed-size word windows, no overlap, headings dropped; add overlap/sentence-aware splitting if needed
export function chunkDocs(docs: Doc[], size: number): Chunk[] {
  return docs.flatMap((d) => {
    const words = d.body.split('\n').filter((l) => !l.startsWith('#')).join(' ').split(/\s+/).filter(Boolean);
    const out: Chunk[] = [];
    for (let i = 0; i < words.length; i += size)
      out.push({ id: `${d.id}#${out.length}`, docId: d.id, text: words.slice(i, i + size).join(' '), access: d.access, superseded: d.superseded_by !== null });
    return out;
  });
}

const STOP = new Set(
  'a an the and or of to in on for is are be by with at from as it its this that can do does i my me we you your our what which who how when where why there their they will was were has have if any all per after before than into about until much many long get'.split(' '),
);
// ponytail: naive tokenizer + plural stripping; a real stemmer/lemmatizer is the upgrade
export const tokens = (t: string) =>
  (t.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !STOP.has(w)).map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));

export const sentences = (t: string) => t.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => tokens(s).length > 0);

// "Embedding model" = switchable sparse vectorizer, so a model change can be demoed offline.
function embed(text: string, mode: Config['embedding']): Map<string, number> {
  let grams = tokens(text);
  if (mode === 'char-trigram') {
    const s = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
    grams = [];
    for (let i = 0; i + 3 <= s.length; i++) grams.push(s.slice(i, i + 3));
  }
  const v = new Map<string, number>();
  for (const g of grams) v.set(g, (v.get(g) ?? 0) + 1);
  return v;
}

function cosine(a: Map<string, number>, b: Map<string, number>) {
  let dot = 0, na = 0, nb = 0;
  for (const [k, x] of a) { na += x * x; dot += x * (b.get(k) ?? 0); }
  for (const x of b.values()) nb += x * x;
  return dot ? dot / Math.sqrt(na * nb) : 0;
}

export const visible = (c: Chunk, role: Role, cfg: Pick<Config, 'accessFilter' | 'excludeSuperseded'>) =>
  (!cfg.accessFilter || role === 'agent' || c.access === 'public') && (!cfg.excludeSuperseded || !c.superseded);

// ponytail: brute-force scan over all chunks, fine for hundreds; ANN index when corpus grows
export function retrieve(question: string, chunks: Chunk[], role: Role, cfg: Config): Hit[] {
  const q = embed(question, cfg.embedding);
  return chunks
    .filter((c) => visible(c, role, cfg))
    .map((c) => ({ ...c, score: cosine(q, embed(c.text, cfg.embedding)) }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, cfg.topK);
}

export const NO_INFO = "I don't have enough information to answer that.";
const HALLUCINATION = 'This applies to every plan without exception.';

export const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// SIMULATION: extractive "generator". Picks the retrieved sentences that best overlap the question,
// cites them as [doc-id#chunk], refuses when overlap is too low. hallucinationRate appends an
// unsupported, uncited claim to mimic an LLM drifting from the context.
export function generate(question: string, ctx: Hit[], cfg: Config, rand: () => number): string {
  const q = new Set(tokens(question));
  const picks = ctx
    .flatMap((c) => sentences(c.text).map((s) => ({ s, c, score: tokens(s).filter((w, i, a) => q.has(w) && a.indexOf(w) === i).length / q.size })))
    .sort((a, b) => b.score - a.score) // stable: ties keep retrieval rank
    .filter((p) => p.score >= cfg.minAnswerOverlap)
    .slice(0, 2);
  if (!picks.length) return NO_INFO;
  const answer = picks.map((p) => `${p.s} [${p.c.id}]`).join(' ');
  return rand() < cfg.hallucinationRate ? `${answer} ${HALLUCINATION}` : answer;
}
