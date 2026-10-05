import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { ProjectRuntime } from '../runtime/project.mjs';
import { createCheckoutFixture } from '../scripts/fixture.mjs';
import { decodeAnswer, createAgentAdapter } from '../runtime/adapters.mjs';
import { validateAlignment } from '../runtime/commercial.mjs';
import { publicAddress } from '../runtime/research.mjs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

test('OpenCode protocol quota errors are not swallowed by tolerant JSON framing', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-oc-quota-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agent = createAgentAdapter('opencode', { executable: process.execPath, argsPrefix: [fileURLToPath(new URL('./fixtures/agent-cli.mjs', import.meta.url))], env: { DSH_PROTOCOL_FIXTURE: 'opencode', DSH_PROTOCOL_QUOTA: '1' } });
  const run = await agent.start({ role: 'decide', workspace: root, artifactDir: root, runKey: randomUUID(), prompt: 'quota probe', timeoutMs: 10000 });
  try { await assert.rejects(run.result, /Usage limit exceeded/); assert.equal(agent.availability, 'offline'); }
  finally { await run.dispose(); }
});

test('public benchmark fetching rejects local and metadata network destinations', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.20.0.1', '192.168.1.1', '100.64.0.1', '192.0.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '::1', '::ffff:127.0.0.1', 'fc00::1', '2001:db8::1']) assert.equal(publicAddress(address), false);
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.equal(publicAddress('2606:4700:4700::1111'), true);
});

test('research transport preserves free prose without requiring JSON', () => {
  assert.deepEqual(decodeAnswer('## Comparison\nThis route misses payment recovery.', 'text'), { text: '## Comparison\nThis route misses payment recovery.' });
  assert.equal(decodeAnswer('\n  Advice with deliberate whitespace.\n', 'text').text, '\n  Advice with deliberate whitespace.\n');
  assert.throws(() => decodeAnswer('', 'text'), /Empty/);
  assert.throws(() => decodeAnswer('Unstructured decision', 'json'), /JSON/);
});

test('OpenCode attachments fit native ReadTool byte line-length and line-count limits', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-oc-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = createAgentAdapter('opencode');
  const spec = await adapter.prepare({ role: 'decide', workspace: root, artifactDir: root, runKey: randomUUID(), outputFormat: 'text', prompt: JSON.stringify({ first: '真实证据'.repeat(18000), tail: 'CURRENT_BROWSER_EVIDENCE_34_PASS' }) + '\n' + 'line\n'.repeat(5000) });
  const files = spec.args.flatMap((arg, index) => arg === '--file' ? [spec.args[index + 1]] : []);
  let visible = '';
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    assert.ok(Buffer.byteLength(content) <= 28000, 'ReadTool caps each file at 50KB');
    assert.ok(content.split('\n').length <= 901, 'ReadTool caps at 2000 lines');
    assert.ok(content.split('\n').every(line => line.length <= 1400), 'ReadTool silently truncates lines at 2000 characters');
    visible += content;
  }
  assert.match(visible, /CURRENT_BROWSER_EVIDENCE_34_PASS/);
  assert.ok(files.length > 1);
});

test('commercial gate cannot accept blockers or unknown outcomes', () => {
  assert.throws(() => validateAlignment({ outcome: 'PASS', reason: 'fine', evidence: ['test'], blockers: ['payment failed'] }), /blockers/);
  assert.throws(() => validateAlignment({ outcome: 'DONE', reason: 'fine', evidence: ['test'], blockers: [] }), /Invalid/);
  assert.throws(() => validateAlignment({ outcome: 'PASS', reason: 'fine', evidence: [], blockers: [] }), /Invalid/);
});

async function fixture(t, behavior = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-commercial-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = await createCheckoutFixture(path.join(root, 'repo'));
  const notes = '# Reference fit\nCompare current quantity totals to commerce Money semantics. UI verification remains a separate requirement.';
  const events = [];
  const agent = id => ({ id, identity: id, provider: 'test-double', availability: 'online', roles: ['build', 'decide', 'review'], capabilities: ['reason', 'code', 'review', 'security'], trust: 0.8, cost: 1,
    describe() { return { id, roles: this.roles, availability: this.availability }; },
    async start(task) { events.push({ id, role: task.role, format: task.outputFormat }); return { id: `${id}-${events.length}`, result: Promise.resolve().then(async () => {
      if (behavior.run) return behavior.run(this, task, notes);
      if (task.outputFormat === 'text') return { text: notes };
      return { outcome: behavior.outcome ?? 'PASS', reason: 'Stage evidence checked', evidence: ['fixture source and benchmark'], blockers: behavior.outcome ? ['Missing deployment proof'] : [] };
    }), dispose: async () => events.push({ id, stopped: true }) }; }
  });
  const config = { ...f, stateDir: path.join(root, 'state'), tests: [{ executable: process.execPath, args: ['--test', 'tests/acceptance.test.mjs'] }], protectedPaths: ['tests/acceptance.test.mjs'], commercialLoop: { enabled: true, worker: 'opencode', references: [{ url: 'https://example.com/commerce', text: 'Test double source only; quantities multiply unit Money amounts.' }] } };
  const runtime = new ProjectRuntime(config, { agents: [agent('opencode'), agent('pi'), agent('dsh')] });
  await runtime.initialize();
  return { runtime, root, events, notes, config };
}

test('each alignment preserves notes and independent audit without modifying source', async t => {
  const { runtime, root, notes, config } = await fixture(t);
  const before = await runtime.worktrees.snapshot(config.repository);
  const record = await runtime.alignment('plan', { tests: [] }, { directory: config.repository });
  assert.equal(record.worker, 'opencode'); assert.notEqual(record.reviewer, record.worker);
  assert.equal(await readFile(path.join(root, 'state', record.notesPath), 'utf8'), notes);
  assert.equal((await runtime.worktrees.snapshot(config.repository)).hash, before.hash);
  assert.equal((await runtime.store.load()).alignments.length, 1);
  const restarted = new ProjectRuntime(config, { agents: [...runtime.registry.agents.values()] });
  await restarted.initialize();
  assert.equal(restarted.lastAlignment.text, notes, 'Restart restores original advice, not just a status summary');
});

test('missing commercial evidence blocks planning and is retained on disk', async t => {
  const { runtime, config } = await fixture(t, { outcome: 'NEED_RESEARCH' });
  await assert.rejects(runtime.alignment('plan', {}, { directory: config.repository }), /COMMERCIAL_NEED_RESEARCH/);
  assert.equal((await runtime.store.load()).alignments[0].audit.outcome, 'NEED_RESEARCH');
});

test('Host researcher discovers verified benchmarks without preconfigured references', async t => {
  const { runtime, config } = await fixture(t);
  runtime.config.commercialLoop.references = [];
  const calls = [];
  runtime.commercial.research = async (ref, context) => {
    calls.push({ ref, stage: context.stage, goal: context.goal });
    return [{ url: 'https://example.com/discovered', title: 'Discovered commerce reference', text: 'Host verified fixture benchmark document.' }];
  };
  const record = await runtime.alignment('plan', {}, { directory: config.repository });
  assert.equal(calls[0].ref, null); assert.equal(calls[0].stage, 'plan');
  assert.equal(record.audit.outcome, 'PASS'); assert.equal(record.sources[0].verified, true);
  runtime.commercial.research = async () => ({ text: 'Unsupported claim without a source URL' });
  await assert.rejects(runtime.alignment('plan', {}, { directory: config.repository }), /COMMERCIAL_NEED_RESEARCH/);
});

test('quota handoff preserves partial files and excludes every contributing builder from review', async t => {
  let resumed = false;
  const { runtime, events, config } = await fixture(t, { run: async (agent, task) => {
    if (agent.id === 'opencode') {
      await writeFile(path.join(task.workspace, 'partial.txt'), 'preserved work'); agent.availability = 'offline'; throw new Error('Usage limit exceeded');
    }
    assert.equal(await readFile(path.join(task.workspace, 'partial.txt'), 'utf8'), 'preserved work');
    assert.match(task.prompt, /SAME action/); resumed = true; return { summary: 'continued' };
  } });
  runtime.state.actions.push({ id: 'action', builder: 'opencode', builderIdentity: 'opencode' });
  const result = await runtime.executeWithHandoff(runtime.registry.get('opencode'), { role: 'build', actionId: 'action', workspace: config.repository, capabilities: ['code'], prompt: 'Finish current action' });
  assert.ok(resumed); assert.notEqual(result.worker, 'opencode');
  assert.ok(events.findIndex(e => e.id === 'opencode' && e.stopped) < events.findIndex(e => e.id !== 'opencode'));
  assert.deepEqual(runtime.state.actions[0].builderIdentities, ['opencode', result.worker]);
  assert.equal((await runtime.store.load()).handoffs[0].status, 'resuming');
});

test('unconfirmed worker stop forbids quota takeover', async t => {
  const { runtime, config, events } = await fixture(t);
  const first = runtime.registry.get('opencode');
  first.start = async () => { first.availability = 'offline'; return { id: 'bad', result: Promise.reject(new Error('Usage limit exceeded')), dispose: async () => { throw new Error('still alive'); } }; };
  await assert.rejects(runtime.executeWithHandoff(first, { role: 'build', workspace: config.repository, prompt: 'act' }), /STOP_UNCONFIRMED/);
  assert.equal(events.length, 0);
});

test('recreated adapter identities cannot let a previous contributor audit its work', async t => {
  const { runtime, config } = await fixture(t);
  const action = { id: 'restarted-action', builder: 'opencode', builderIdentity: 'old-opencode-session', builderIdentities: ['old-opencode-session', 'old-pi-session'], builderHistory: ['pi', 'opencode'] };
  const record = await runtime.alignment('verify', {}, { directory: config.repository }, action);
  assert.equal(record.reviewer, 'dsh', 'Stable contributor IDs stay excluded after identities change on restart');
});

test('plan audit excludes the selected Builder even when another platform writes the advice', async t => {
  const { runtime, config } = await fixture(t);
  const record = await runtime.alignment('plan', { proposedAction: { workerId: 'pi' } }, { directory: config.repository });
  assert.equal(record.worker, 'opencode'); assert.equal(record.reviewer, 'dsh');
});

test('green committed tests and code review cannot override a PARTIAL commercial audit', async t => {
  const { runtime, config } = await fixture(t, { run: async (_agent, task, notes) => {
    if (task.outputFormat === 'text' && task.role !== 'build') return { text: notes };
    if (task.role === 'build') {
      assert.equal(task.outputFormat, 'text', 'Builder prose does not need a JSON completion contract');
      assert.match(task.prompt, /live-schema-test-marker/, 'Host API observations must reach the Builder, not just the planner');
      await writeFile(path.join(task.workspace, 'checkout.mjs'), 'export const total = items => items.reduce((sum, item) => sum + item.price * (item.quantity ?? 1), 0);\nexport const delivery = items => total(items) >= 30 ? 0 : 5;\n');
      await writeFile(path.join(task.workspace, 'style.css'), '.checkout { display: block; padding: 16px; }\n');
      return { text: 'Functional fixture corrected; Host must verify actual changes.' };
    }
    if (task.outputSchema?.outcome) return { outcome: task.prompt.includes('audit the verify') ? 'PARTIAL' : 'PASS', reason: 'Core tests are insufficient for commercial UI proof', evidence: ['committed test evidence'], blockers: task.prompt.includes('audit the verify') ? ['Unverified accessibility'] : [] };
    return { verdict: 'pass', reason: 'Code checked', evidence: ['source and tests'], blockingRisks: [] };
  } });
  runtime.assessment = async () => ({ complete: false, reason: 'Fix core flow', gaps: [{ id: 'core', description: 'Broken flow', priority: 95, evidence: ['acceptance tests'] }], candidates: [{ gapId: 'core', goal: 'Fix flow', capabilities: ['code'], risk: 'normal', strategy: 'repair' }] });
  runtime.observeExtra = async () => ({ liveContract: 'live-schema-test-marker' });
  const accepted = runtime.state.acceptedHead;
  await runtime.start({ maxActions: 1 });
  const action = runtime.state.actions[0];
  assert.ok(action.tests.every(t => t.passed)); assert.ok(action.committedTests.every(t => t.passed));
  assert.equal(action.reviews[0].verdict, 'pass');
  assert.equal(action.commercialReview.audit.outcome, 'PARTIAL');
  assert.equal(action.phase, 'REJECTED'); assert.equal(runtime.state.acceptedHead, accepted);
  assert.deepEqual(runtime.state.alignments.map(a => a.stage), ['observe-and-prioritize', 'plan', 'execution-route', 'verify']);
  assert.equal(await runtime.worktrees.git(config.repository, ['rev-parse', 'HEAD']), accepted);
});

test('green project observation cannot complete without independent commercial evidence', async t => {
  const { runtime, config } = await fixture(t, { run: async (_agent, task, notes) => {
    if (task.outputFormat === 'text') return { text: notes };
    const final = task.prompt.includes('audit the commercial-completion');
    return { outcome: final ? 'NEED_RESEARCH' : 'PASS', reason: 'Missing deployment validation', evidence: ['supplied source'], blockers: final ? ['Deployment unknown'] : [] };
  } });
  runtime.assessment = async () => ({ complete: true, reason: 'Tests green', gaps: [], candidates: [] });
  const tree = { directory: config.repository };
  const snapshot = await runtime.worktrees.snapshot(config.repository);
  await assert.rejects(runtime.decide({ head: runtime.state.acceptedHead, acceptedHead: runtime.state.acceptedHead, snapshot, tests: [{ passed: true }] }, tree), /COMMERCIAL_NEED_RESEARCH/);
  assert.notEqual(runtime.state.status, 'complete');
});

test('PARTIAL diagnosis feeds decision while an unapproved plan cannot dispatch a Builder', async t => {
  const { runtime, events, config } = await fixture(t, { outcome: 'PARTIAL' });
  let seen;
  runtime.assessment = async (_state, observation) => {
    seen = observation.alignmentAudit;
    return { complete: false, reason: 'Consider audit', gaps: [{ id: 'gap', description: 'Incomplete discovery', priority: 90, evidence: ['audit'] }], candidates: [{ gapId: 'gap', goal: 'Improve discovery', capabilities: ['code'], risk: 'normal', strategy: 'repair' }] };
  };
  const snapshot = await runtime.worktrees.snapshot(config.repository);
  await assert.rejects(runtime.decide({ head: runtime.state.acceptedHead, acceptedHead: runtime.state.acceptedHead, snapshot, tests: [{ passed: true }] }, { directory: config.repository }), /COMMERCIAL_PARTIAL/);
  assert.equal(seen.outcome, 'PARTIAL');
  assert.ok(events.every(event => event.role !== 'build'));
  assert.equal(runtime.state.actions.length, 0);
});

test('greenfield loop creates a missing product and verifies it without seeded implementation defects', async t => {
  // Deterministic contract test, not a claim of native autonomous product delivery.
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-greenfield-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repo'); await mkdir(repository);
  await writeFile(path.join(repository, 'README.md'), '# Product brief\nCreate a quantity-aware quotation API for a small catalog.\n');
  const git = args => execFileSync('git', ['-C', repository, ...args], { stdio: 'pipe' });
  git(['init', '-b', 'main']); git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgSign=false', 'commit', '-m', 'Product brief only']);
  const acceptance = path.join(root, 'host-acceptance.mjs');
  await writeFile(acceptance, `import assert from 'node:assert/strict';\nimport path from 'node:path';\nimport {pathToFileURL} from 'node:url';\nconst {quote}=await import(pathToFileURL(path.join(process.cwd(),'catalog.mjs')));\nassert.equal(quote([{price:5,quantity:3},{price:2,quantity:1}]),17);\nassert.equal(quote([]),0);\n`);
  const events = [];
  const agent = id => ({ id, identity: id, roles: ['decide', 'build', 'review'], capabilities: ['reason', 'code', 'review'], availability: 'online', trust: 0.8, cost: 1,
    async start(task) { events.push({ id, role: task.role }); return { id: randomUUID(), dispose: async () => {}, result: Promise.resolve().then(async () => {
      if (task.outputFormat === 'text' && task.role === 'decide') {
        assert.match(task.prompt, /primarily develops NEW products/);
        return { text: 'A product brief is present but the quotation capability is absent. Construct the smallest quantity-aware API and verify its actual behavior. Reference scope is a test fixture, not a real commerce benchmark.' };
      }
      if (task.role === 'build') {
        await assert.rejects(readFile(path.join(task.workspace, 'catalog.mjs')), { code: 'ENOENT' });
        await writeFile(path.join(task.workspace, 'catalog.mjs'), 'export const quote = items => items.reduce((sum,item) => sum+item.price*item.quantity,0);\n');
        return { text: 'Created the missing quotation API; Host must validate it.' };
      }
      if (task.outputSchema?.complete) {
        assert.match(task.prompt, /primary use case is developing NEW products/);
        let implemented = false; try { await readFile(path.join(task.workspace, 'catalog.mjs')); implemented = true; } catch {}
        return implemented ? { complete: true, reason: 'Scoped quotation behavior verified', gaps: [], candidates: [] } : { complete: false, reason: 'Product has not been implemented', gaps: [{ id: 'missing-api', description: 'Quotation API absent', priority: 95, evidence: ['Only a product brief exists; Host acceptance fails missing module'] }], candidates: [{ gapId: 'missing-api', goal: 'Create quantity-aware quotation API', capabilities: ['code'], risk: 'normal', strategy: 'replace' }] };
      }
      if (task.outputSchema?.outcome) return { outcome: 'PASS', reason: 'Fixture stage evidence checked within narrow scope', evidence: ['product brief and actual Host acceptance'], blockers: [] };
      return { verdict: 'pass', reason: 'Actual candidate and acceptance checked', evidence: ['quantity-aware quotation implementation'], blockingRisks: [] };
    }) }; }, describe() { return { id }; } });
  const runtime = new ProjectRuntime({ repository, stateDir: path.join(root, 'state'), goal: 'Develop a new quantity-aware quotation API', successCriteria: ['Requested quotation API is implemented and passes external Host acceptance'], tests: [{ executable: process.execPath, args: [acceptance] }], commercialLoop: { enabled: true, worker: 'opencode', references: [{ url: 'https://example.com/quotation', text: 'Test fixture reference: quotation totals sum price times quantity.' }] } }, { agents: [agent('opencode'), agent('pi'), agent('dsh')] });
  t.after(() => runtime.close());
  await runtime.start({ maxActions: 2 });
  assert.equal(runtime.state.status, 'complete');
  assert.equal(runtime.state.actions.length, 1);
  const action = runtime.state.actions[0];
  assert.equal(action.phase, 'MERGE_READY');
  assert.ok(action.tests.every(t => t.passed) && action.committedTests.every(t => t.passed));
  assert.notEqual(action.reviews[0].reviewer, action.builder);
  assert.equal(runtime.state.decisions.length, 2, 'Re-observe the newly created product before completion');
  assert.equal(runtime.state.alignments.at(-1).stage, 'commercial-completion');
  await assert.rejects(readFile(path.join(repository, 'catalog.mjs')), { code: 'ENOENT' });
  assert.ok(events.some(event => event.role === 'build'));
});
