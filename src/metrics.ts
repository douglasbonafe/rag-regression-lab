// Per-layer checks. Each returns a score in [0,1] or a boolean; the eval turns them into pass/fail.
import { type Chunk, type Role, sentences, tokens } from './rag.ts';

// Pipeline order: "first failing layer" is the first one in this list that fails.
export const LAYERS = ['retrieval', 'access', 'freshness', 'generation', 'citations', 'no_evidence', 'answer'] as const;
export type Layer = (typeof LAYERS)[number];
export const CRITICAL: Layer[] = ['access', 'freshness'];

export const isRefusal = (a: string) => a.includes("I don't have enough information");
const lower = (s: string) => s.toLowerCase();

/** Retrieval: share of needed docs present in the top-k (context recall@k at doc level). */
export function contextRecall(needed: string[], retrieved: Chunk[]) {
  if (!needed.length) return 1;
  const got = new Set(retrieved.map((c) => c.docId));
  return needed.filter((d) => got.has(d)).length / needed.length;
}

/** Retrieval: share of expected key facts literally present in some retrieved chunk (Ragas-style context recall, string-match proxy). */
export function factRecall(facts: string[], retrieved: Chunk[]) {
  if (!facts.length) return 1;
  return facts.filter((f) => retrieved.some((c) => lower(c.text).includes(lower(f)))).length / facts.length;
}

// ponytail: token-overlap support check; an NLI model or LLM judge (Ragas faithfulness) is the upgrade
export function supportedBy(claim: string, text: string, min = 0.8) {
  const t = tokens(claim);
  if (!t.length) return false;
  const have = new Set(tokens(text));
  return t.filter((w) => have.has(w)).length / t.length >= min;
}

/** Split an answer into claims; text before a [doc#n] marker is the claim it cites. Trailing text = uncited claims. */
export function parseClaims(answer: string) {
  const out: { text: string; cite?: string }[] = [];
  let last = 0;
  for (const m of answer.matchAll(/\[([^\]]+)\]/g)) {
    out.push({ text: answer.slice(last, m.index).trim(), cite: m[1] });
    last = m.index! + m[0].length;
  }
  for (const s of sentences(answer.slice(last))) out.push({ text: s });
  return out.filter((c) => c.text);
}

/** Generation: share of claims supported by at least one retrieved chunk. Faithful != correct. */
export function faithfulness(answer: string, retrieved: Chunk[]) {
  if (isRefusal(answer)) return 1;
  const claims = parseClaims(answer);
  if (!claims.length) return 0;
  return claims.filter((c) => retrieved.some((ch) => supportedBy(c.text, ch.text))).length / claims.length;
}

/** Citations: at least one citation, every cited chunk exists and supports the claim it is attached to. */
export function citationsOk(answer: string, corpus: Map<string, Chunk>) {
  if (isRefusal(answer)) return true;
  const cited = parseClaims(answer).filter((c) => c.cite);
  if (!cited.length) return false;
  return cited.every((c) => {
    const ch = corpus.get(c.cite!);
    return !!ch && supportedBy(c.text, ch.text);
  });
}

/** Access: a customer must never receive internal chunks (checked on retrieved context, not just the answer). */
export const accessOk = (role: Role, retrieved: Chunk[]) => role === 'agent' || retrieved.every((c) => c.access === 'public');

/** Freshness: no cited chunk may come from a superseded document version. */
export const freshnessOk = (answer: string, corpus: Map<string, Chunk>) =>
  parseClaims(answer).every((c) => !c.cite || !corpus.get(c.cite)?.superseded);

/** Answer (end-to-end symptom): all key facts present, no refusal. */
export const answerOk = (answer: string, facts: string[]) => !isRefusal(answer) && facts.every((f) => lower(answer).includes(lower(f)));
