import { describe, expect, it } from 'vitest';
import { type Chunk, Config, NO_INFO, parseDoc, retrieve } from '../src/rag.ts';
import { accessOk, citationsOk, contextRecall, factRecall, faithfulness, freshnessOk } from '../src/metrics.ts';

const chunk = (id: string, text: string, access: Chunk['access'] = 'public', superseded = false): Chunk => ({ id, docId: id.split('#')[0], text, access, superseded });
const refund = chunk('refund-v2#0', 'Customers may request a full refund within 30 days of purchase.');
const oldRefund = chunk('refund-v1#0', 'Customers may request a full refund within 14 days of purchase.', 'public', true);
const discount = chunk('discount#0', 'Support agents may approve a discount of up to 20% on the next invoice.', 'internal');
const corpus = new Map([refund, oldRefund, discount].map((c) => [c.id, c]));
const cfg = Config.parse({ name: 't', chunkSize: 50, topK: 3, embedding: 'bow' });

describe('context recall', () => {
  it('is 1 when every needed doc is retrieved, partial otherwise', () => {
    expect(contextRecall(['refund-v2'], [refund, discount])).toBe(1);
    expect(contextRecall(['refund-v2', 'discount'], [refund])).toBe(0.5);
  });
  it('empty retrieval fails when docs are needed', () => {
    expect(contextRecall(['refund-v2'], [])).toBe(0);
    expect(factRecall(['30 days'], [])).toBe(0);
  });
  it('fact recall checks the fact text is actually in the context', () => {
    expect(factRecall(['within 30 days of purchase'], [refund])).toBe(1);
    expect(factRecall(['within 30 days of purchase'], [oldRefund])).toBe(0);
  });
});

describe('citation check', () => {
  it('passes when the cited chunk exists and supports the claim', () => {
    expect(citationsOk('Customers may request a full refund within 30 days of purchase. [refund-v2#0]', corpus)).toBe(true);
  });
  it('fails on a citation to a chunk that does not exist', () => {
    expect(citationsOk('Customers may request a full refund within 30 days of purchase. [refund-v9#3]', corpus)).toBe(false);
  });
  it('fails when the cited chunk does not contain the claim', () => {
    expect(citationsOk('Customers may request a full refund within 30 days of purchase. [discount#0]', corpus)).toBe(false);
  });
  it('fails on an empty or uncited answer, passes on an explicit refusal', () => {
    expect(citationsOk('', corpus)).toBe(false);
    expect(citationsOk('Refunds are available for 30 days.', corpus)).toBe(false);
    expect(citationsOk(NO_INFO, corpus)).toBe(true);
  });
});

describe('faithfulness proxy', () => {
  it('flags an unsupported extra claim', () => {
    const a = 'Customers may request a full refund within 30 days of purchase. [refund-v2#0] Refunds are processed instantly by drones.';
    expect(faithfulness(a, [refund])).toBe(0.5);
  });
  it('empty answer or empty context fails', () => {
    expect(faithfulness('', [refund])).toBe(0);
    expect(faithfulness('Customers may request a full refund within 30 days of purchase. [refund-v2#0]', [])).toBe(0);
  });
});

describe('access filter', () => {
  it('customers never retrieve internal chunks when the filter is on', () => {
    const hits = retrieve('What discount can agents approve?', [refund, discount], 'customer', cfg);
    expect(hits.map((h) => h.id)).not.toContain('discount#0');
    expect(accessOk('customer', hits)).toBe(true);
  });
  it('agents do see internal chunks', () => {
    expect(retrieve('What discount can agents approve?', [refund, discount], 'agent', cfg)[0].id).toBe('discount#0');
  });
  it('accessOk flags a leak when the filter is off', () => {
    const hits = retrieve('What discount can agents approve?', [refund, discount], 'customer', { ...cfg, accessFilter: false });
    expect(accessOk('customer', hits)).toBe(false);
  });
});

describe('freshness', () => {
  it('fails when a superseded version is cited', () => {
    expect(freshnessOk('Refunds within 14 days of purchase. [refund-v1#0]', corpus)).toBe(false);
    expect(freshnessOk('Refunds within 30 days of purchase. [refund-v2#0]', corpus)).toBe(true);
  });
});

describe('front-matter', () => {
  it('parses version metadata and rejects bad access values', () => {
    const d = parseDoc('---\nid: x\nversion: 2\neffective_date: 2025-01-01\nsuperseded_by: null\naccess: public\n---\nBody.');
    expect(d).toMatchObject({ id: 'x', version: 2, superseded_by: null, access: 'public' });
    expect(() => parseDoc('---\nid: x\nversion: 1\neffective_date: 2025\nsuperseded_by:\naccess: secret\n---\n')).toThrow();
  });
});
