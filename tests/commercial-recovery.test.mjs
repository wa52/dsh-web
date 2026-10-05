import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectRuntime } from '../runtime/project.mjs';
import { createCheckoutFixture } from '../scripts/fixture.mjs';
import { extractCandidateUrls } from '../runtime/commercial.mjs';
import { readBenchmark } from '../runtime/research.mjs';

// Deterministic, additive coverage for the bounded default reference-recovery
// capability. Test-double agents and an injectable fetch seam keep these free of
// real network; the fetch-safety test drives the real readBenchmark guard against
// numeric non-public addresses only (no DNS, no outbound request).

async function fixture(t, { fetchBenchmark, decideText, seedUrl = 'https://example.com/seed' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-commercial-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = await createCheckoutFixture(path.join(root, 'repo'));
  const notes = decideText ?? '# Reference fit\nNo verified benchmark available yet.';
  const agent = id => ({ id, identity: id, provider: 'test-double', availability: 'online', roles: ['build', 'decide', 'review'], capabilities: ['reason', 'code', 'review', 'security'], trust: 0.8, cost: 1,
    describe() { return { id, roles: this.roles, availability: this.availability }; },
    async start(task) { return { id: `${id}-${Date.now()}`, result: Promise.resolve().then(() => {
      if (task.outputFormat === 'text') return { text: notes };
      return { outcome: 'PASS', reason: 'Stage evidence checked', evidence: ['fixture source and benchmark'], blockers: [] };
    }), dispose: async () => {} }; }
  });
  const config = { ...f, stateDir: path.join(root, 'state'), tests: [{ executable: process.execPath, args: ['--test', 'tests/acceptance.test.mjs'] }], protectedPaths: ['tests/acceptance.test.mjs'], commercialLoop: { enabled: true, worker: 'opencode', fetchReferences: true, maxAlignmentAttempts: 2, references: [{ url: seedUrl, title: 'Seed reference' }] } };
  const runtime = new ProjectRuntime(config, { agents: [agent('opencode'), agent('pi'), agent('dsh')] });
  await runtime.initialize();
  if (fetchBenchmark) runtime.commercial.fetchBenchmark = fetchBenchmark;
  return { runtime, root, config };
}

test('oversized seed recovers to a retrieved alternative that changes sources', async t => {
  const candidateUrl = 'https://example.com/alternative';
  const fetcher = async ref => {
    if (ref.url === 'https://example.com/seed') throw Object.assign(new Error('Benchmark document exceeds 512KB budget'), { reason: 'oversized' });
    if (ref.url === candidateUrl) return { url: ref.url, title: 'Retrieved alternative', retrievedAt: new Date().toISOString(), truncated: false, text: 'A mature help-desk benchmark describing a shared inbox, roles, reports and CSV export.' };
    throw Object.assign(new Error('Benchmark HTTP 404; redirects are not followed'), { reason: 'http-404' });
  };
  const decideText = `# Analysis\nSeed reference is oversized. Propose a bounded alternative:\n\`\`\`proposed-references\n${candidateUrl}\n\`\`\`\n`;
  const { runtime, root, config } = await fixture(t, { fetchBenchmark: fetcher, decideText });
  const record = await runtime.alignment('plan', {}, { directory: config.repository });
  assert.equal(record.audit.outcome, 'PASS', 'Recovery must enable a PASS when a candidate is safely retrieved');
  const seed = record.sources.find(source => source.url === 'https://example.com/seed');
  assert.equal(seed.verified, false); assert.equal(seed.reason, 'oversized');
  const candidate = record.sources.find(source => source.url === candidateUrl);
  assert.equal(candidate.verified, true);
  const context = JSON.parse(await readFile(path.join(root, 'state', 'evidence', record.id, 'context.json'), 'utf8'));
  assert.match(context.sources.find(source => source.url === candidateUrl).text, /shared inbox/);
});

test('bounded exhaustion when every candidate fails, honest provenance, no PASS', async t => {
  let fetchCalls = 0;
  const fetcher = async ref => {
    fetchCalls++;
    throw Object.assign(new Error(ref.url === 'https://example.com/seed' ? 'Benchmark document exceeds 512KB budget' : 'Benchmark HTTP 404; redirects are not followed'), { reason: ref.url === 'https://example.com/seed' ? 'oversized' : 'http-404' });
  };
  const decideText = `# Analysis\nSeed oversized. Alternative proposal:\n\`\`\`proposed-references\nhttps://example.com/candidate\n\`\`\`\n`;
  const { runtime, config } = await fixture(t, { fetchBenchmark: fetcher, decideText });
  await assert.rejects(runtime.alignment('plan', {}, { directory: config.repository }), /COMMERCIAL_NEED_RESEARCH/);
  assert.equal(fetchCalls, 2, 'Only the seed and one candidate are fetched once; retries serve from cache');
  const alignments = (await runtime.store.load()).alignments;
  assert.equal(alignments.length, 2, 'Exhaustion is bounded by maxAlignmentAttempts');
  assert.ok(alignments.every(alignment => alignment.audit.outcome === 'NEED_RESEARCH'), 'No PASS is fabricated when all candidates fail');
  const record = alignments.at(-1);
  assert.ok(record.sources.every(source => source.verified === false));
  assert.ok(record.sources.some(source => source.reason === 'oversized'));
  assert.ok(record.sources.some(source => source.reason === 'http-404'));
  assert.ok(record.sources.some(source => source.reason === 'all-candidates-failed'));
});

test('recovery candidates retain public-address/fetch-safety rejection', async t => {
  const decideText = `# Analysis\nPropose alternatives:\n\`\`\`proposed-references\nhttps://127.0.0.1/candidate\n\`\`\`\n`;
  const { runtime, config } = await fixture(t, { seedUrl: 'https://127.0.0.1/seed', decideText });
  await assert.rejects(runtime.alignment('plan', {}, { directory: config.repository }), /COMMERCIAL_NEED_RESEARCH/);
  const record = (await runtime.store.load()).alignments.at(-1);
  assert.ok(record.sources.every(source => source.verified === false));
  assert.ok(record.sources.some(source => source.reason === 'non-public-address'));
});

test('readBenchmark classifies failures with stable typed reasons', async () => {
  assert.equal((await readBenchmark({ url: 'http://example.com/x' }).catch(error => error)).reason, 'invalid-url');
  assert.equal((await readBenchmark({ url: 'https://127.0.0.1/x' }).catch(error => error)).reason, 'non-public-address');
});

test('extractCandidateUrls parses only a fenced proposed-references block', () => {
  const text = 'Prose https://example.com/noise\n```proposed-references\nhttps://example.com/a\nhttp://example.com/not-https\nhttps://example.com/a\nhttps://example.com/b\n```\n';
  assert.deepEqual(extractCandidateUrls(text), ['https://example.com/a', 'https://example.com/b']);
  assert.deepEqual(extractCandidateUrls('No fence; https://example.com/x'), []);
  assert.deepEqual(extractCandidateUrls('```proposed-references\nhttps://example.com/a\n```', ['https://example.com/a']), []);
  const many = '```proposed-references\n' + Array.from({ length: 20 }, (_, i) => `https://example.com/${i}`).join('\n') + '\n```';
  assert.equal(extractCandidateUrls(many).length, 8);
});
