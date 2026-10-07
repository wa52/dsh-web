import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

// Execute the shipped UI against a minimal DOM and drive its real SSE handler.
// No providers, network requests or external browser dependencies are used.
test('UI mode updates show truthful controls, Web setup and default commercial selection', async () => {
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  const elements = new Map();
  const element = () => ({
    hidden: false, disabled: false, value: '', textContent: '', style: {}, attributes: {},
    classList: { toggle() {} },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener() {}, replaceChildren() {}, append() {},
  });
  for (const match of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const el = element();
    el.hidden = /\shidden(?:\s|>)/.test(match[0]);
    el.checked = /\schecked(?:\s|>)/.test(match[0]);
    elements.set(match[1], el);
  }
  const streams = new Map();
  runInNewContext(source, {
    document: { getElementById: id => elements.get(id), createElement: element },
    EventSource: class { constructor(url) { streams.set(url, this); } },
    fetch: () => new Promise(() => {}),
  });
  const get = id => elements.get(id);
  const update = host => streams.get('/api/events').onmessage({ data: JSON.stringify({ host }) });
  const native = { state: 'idle', sessionId: null };
  update({ mode: 'native', projectConfigured: false, nativeConfigured: false, native });
  assert.equal(get('native-panel').hidden, false);
  assert.equal(get('setup-panel').hidden, true);
  assert.equal(get('project-panel').hidden, true);
  assert.equal(get('project-controls').hidden, true);
  assert.equal(get('native-send').disabled, true);
  assert.match(get('native-status').textContent, /未配置/);
  update({ mode: 'project', projectConfigured: false, nativeConfigured: false, native });
  assert.equal(get('native-panel').hidden, true);
  assert.equal(get('setup-panel').hidden, false);
  assert.equal(get('project-panel').hidden, false);
  assert.equal(get('project-controls').hidden, true);
  assert.equal(get('start').disabled, true);
  assert.equal(get('setup-commercialLoop').checked, true);
  assert.match(get('project-repository').textContent, /填写上方项目设置表单/);
  assert.match(html, /id="project-repository">填写上方项目设置表单，保存后启动 Loop。/);
  const projectWorld = { world: { goal: 'Product', project: { repository: 'fixture-repository' }, actions: [], projectHealth: 0, status: 'idle' }, agents: [], running: false };
  update({ mode: 'project', projectConfigured: true, projectWorld, nativeConfigured: true, native });
  assert.equal(get('setup-panel').hidden, true);
  assert.equal(get('project-controls').hidden, false);
  assert.equal(get('start').disabled, false);
  assert.equal(get('project-repository').textContent, 'fixture-repository');
  update({ mode: 'native', projectConfigured: true, projectWorld, nativeConfigured: true, native });
  assert.equal(get('native-panel').hidden, false);
  assert.equal(get('project-panel').hidden, true);
  assert.equal(get('project-controls').hidden, true);
  assert.equal(get('native-send').disabled, false);
  assert.equal(get('mode-native').attributes['aria-selected'], 'true');
  update({ mode: 'project', projectConfigured: false, nativeConfigured: false, native });
  assert.match(get('project-repository').textContent, /填写上方项目设置表单/);
  assert.equal(get('project-controls').hidden, true);
  // Legacy direct-runtime servers retain their CLI setup guidance and controls.
  streams.get('/api/events').onmessage({ data: JSON.stringify({ world: null, agents: [], running: false }) });
  assert.equal(get('mode-native').hidden, true);
  assert.equal(get('native-panel').hidden, true);
  assert.equal(get('project-controls').hidden, false);
  assert.match(get('project-repository').textContent, /npm start -- --config project\.json/);
});
