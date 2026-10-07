const $ = id => document.getElementById(id);
const phases = ['OBSERVE', 'DECIDE', 'DISPATCH', 'BUILD', 'REVIEW', 'UPDATE', 'REPLAN', 'STOP'];
const text = (element, value) => { if (element) element.textContent = value ?? '—'; };
const node = (tag, value, className) => { const element = document.createElement(tag); if (value !== undefined) text(element, value); if (className) element.className = className; return element; };
let latest;
let hostMode = 'native';
let nativeConnected = false;

function render(data) {
  latest = data;
  const isDirectProject = data.world !== undefined;
  const host = isDirectProject ? null : (data.host ?? {});
  if (isDirectProject) {
    // Legacy server mode: payload is the project runtime view directly.
    renderProject(data, true);
    for (const id of ['native-panel', 'setup-panel', 'mode-native', 'mode-project']) { const el = $(id); if (el) el.hidden = true; }
    $('project-panel').hidden = false;
    const controls = $('project-controls'); if (controls) { controls.hidden = false; controls.style.position = 'static'; }
    return;
  }
  hostMode = host.mode ?? 'native';
  updateModeTabs();
  $(`mode-label`) && text($('mode-label'), hostMode === 'native' ? '普通对话' : '自主项目');
  text($('status'), host.projectConfigured ? '已配置' : '未配置');
  text($('native-workspace'), host.nativeWorkspace ?? '由 Host 配置决定');

  if (host.native) {
    const configured = host.nativeConfigured;
    const st = host.native.state ?? 'idle';
    const statusEl = $('native-status');
    const label = !configured ? '未配置：请在 Host 启用 DSH Provider / Model' : st === 'streaming' ? '响应中…' : st === 'connecting' ? '连接中…' : st === 'error' ? `错误: ${host.native.lastError ?? '未知'}` : st === 'idle' ? (host.native.sessionId ? '就绪' : '已配置 · 未连接') : st === 'stopped' ? '已停止' : st;
    if (statusEl) { text(statusEl, label); statusEl.className = `tag${!configured || st === 'error' ? ' danger' : st === 'streaming' ? ' running' : ''}`; }
    $('native-send').disabled = !configured || st === 'connecting' || st === 'streaming';
    $('native-stop').disabled = !configured || !host.native.sessionId || ['stopped', 'error'].includes(st);
    nativeConnected = Boolean(host.native.sessionId) && !['stopped', 'error'].includes(st);
    const choice = host.nativeChoices?.[0];
    if (choice && !$('native-provider').value && !$('native-model').value) {
      $('native-provider').value = choice.provider;
      $('native-model').value = choice.model;
    }
  }

  if (host.projectConfigured) renderProject(host.projectWorld ?? data.project ?? { world: null, agents: [], running: false });
  else renderProject({ world: null, agents: [], running: false });
  if (host.projectError) text($('message'), host.projectError);
}

function updateModeTabs() {
  for (const mode of ['native', 'project', 'setup']) {
    const panel = $(`${mode}-panel`);
    if (panel) panel.hidden = mode !== hostMode && !(mode === 'setup' && hostMode === 'project' && !latest?.host?.projectConfigured);
  }
  const setupPanel = $('setup-panel');
  if (setupPanel) setupPanel.hidden = !(hostMode === 'project' && !latest?.host?.projectConfigured);
  const projectControls = $('project-controls');
  if (projectControls) projectControls.hidden = hostMode !== 'project' || !latest?.host?.projectConfigured || !latest?.host?.projectWorld;
  for (const mode of ['native', 'project']) {
    const tab = $(`mode-${mode}`);
    if (tab) { tab.setAttribute('aria-selected', String(hostMode === mode)); tab.classList.toggle('active', hostMode === mode); }
  }
}

function renderProject(data, legacy = false) {
  const world = data.world;
  const activePhase = world?.phase === 'REVIEW_REQUIRED' ? 'REVIEW' : world?.phase ?? 'STOP';
  text($('project-goal'), world?.goal ?? '配置一个项目，开始观察');
  text($('project-repository'), world?.project.repository ?? (legacy ? '使用 npm start -- --config project.json 连接项目。' : '填写上方项目设置表单，保存后启动 Loop。'));
  text($('project-health'), world ? `${Math.round(world.projectHealth * 100)}%` : '—');
  text($('project-status'), world?.status ?? '未配置'); text($('phase-label'), world?.phase ?? 'STOP');
  text($('head'), world?.acceptedHead ? `ACCEPTED ${world.acceptedHead.slice(0, 10)}` : '尚无已接受版本');
  $('flow').replaceChildren(...phases.map(phase => node('div', phase, `flow-step${phase === activePhase ? ' active' : ''}${phase === 'REVIEW' ? ' gate' : ''}`)));
  const gaps = [...(world?.gaps ?? [])].sort((a, b) => b.priority - a.priority);
  text($('biggest-gap'), gaps[0]?.description ?? (world?.status === 'complete' ? '阻塞问题已解决' : '等待项目观察'));
  $('gaps').replaceChildren(...gaps.slice(0, 4).map(gap => { const row = node('div', undefined, 'gap'); row.append(node('span', gap.priority, 'priority'), node('p', gap.description)); return row; }));
  const current = world?.actions.at(-1);
  text($('current-action'), current?.goal ?? '尚未执行行动');
  text($('current-state'), `${current ? `${current.builder} · ${current.phase}\n${current.rationale}\n` : ''}${JSON.stringify(world?.currentState ?? {}, null, 2)}`);
  $('agent-list').replaceChildren(...data.agents.map(agent => {
    const card = node('article', undefined, 'agent'); const heading = node('div', undefined, 'agent-header');
    const live = [...(agent.runs ?? [])].reverse().find(run => run.status === 'running' && !run.stoppedAt);
    heading.append(node('h3', agent.id === 'dsh' ? 'DSH' : agent.id === 'pi' ? 'Pi' : agent.id[0].toUpperCase() + agent.id.slice(1)), node('span', live ? 'running' : agent.availability, `tag${live ? ' running' : ''}`));
    const details = node('dl');
    const perf = agent.performance ?? {}; const total = (perf.successes ?? 0) + (perf.failures ?? 0);
    const recent = live ?? agent.runs?.at(-1);
    const rows = [['角色', (recent?.role ?? (agent.roles ?? []).join(' / ')) || '未配置'], ['权限', Object.entries(recent?.permissions ?? agent.permissions ?? world?.permissions ?? {}).filter(([, allowed]) => allowed).map(([key]) => key).join(', ') || '未配置'], ['成功率', total ? `${Math.round(perf.successes / total * 100)}% · ${total} 次` : '暂无执行记录'], ['最近运行', recent?.id.slice(0, 8) ?? '—']];
    for (const [label, value] of rows) details.append(node('dt', label), node('dd', value));
    card.append(heading, details); return card;
  }));
  const actions = [...(world?.actions ?? [])].reverse();
  text($('run-count'), `${actions.length} 个行动`); $('empty-runs').hidden = actions.length > 0;
  $('run-list').replaceChildren(...actions.map(action => {
    const row = node('tr'); const goal = node('td', action.goal); goal.append(node('p', action.rationale, 'small'), node('p', action.builderResult?.summary ?? action.error ?? '', 'small'));
    const status = node('td'); status.append(node('span', action.phase, `tag ${action.phase}`));
    const seconds = action.finishedAt ? `${Math.round((Date.parse(action.finishedAt) - Date.parse(action.startedAt)) / 1000)}s` : '—';
    row.append(goal, node('td', action.builder), status, node('td', action.reviews.map(review => `${review.reviewer}: ${review.verdict}`).join('\n') || '待审核'), node('td', seconds), node('td', action.commit?.slice(0, 10) ?? '—', 'mono')); return row;
  }));
  const evidence = [];
  for (const alignment of [...(world?.alignments ?? [])].reverse().slice(0, 5)) {
    evidence.push([`${alignment.stage} · 对标建议`, alignment.notesPath]);
    evidence.push([`${alignment.audit.outcome} · 对齐审核`, `evidence/${alignment.id}/alignment.json`]);
  }
  for (const action of actions) {
    if (action.diffPath) evidence.push([`${action.id.slice(0, 6)} · Diff`, `evidence/${action.id}/change.diff`]);
    if (action.tests) evidence.push([`${action.id.slice(0, 6)} · Tests`, `evidence/${action.id}/tests.json`]);
    for (const review of action.reviews) evidence.push([`${review.reviewer} · ${review.verdict}`, `evidence/${action.id}/review-${review.reviewer}.json`]);
  }
  for (const run of [...(world?.runs ?? [])].reverse().slice(0, 8)) if (run.logPath) {
    const normalized = run.logPath.replaceAll('\\', '/');
    evidence.push([`${run.worker} · Log`, normalized.slice(normalized.lastIndexOf('/evidence/') + 1)]);
  }
  $('evidence-list').replaceChildren(...evidence.slice(0, 20).map(([label, file]) => {
    const button = node('button', label); button.addEventListener('click', async () => {
      try { const response = await fetch(`/api/artifact?path=${encodeURIComponent(file)}`); const result = await response.json(); text($('artifact'), result.text ?? result.error); }
      catch { text($('artifact'), '证据读取失败，请检查连接。'); }
    }); return button;
  }));
  $('start').disabled = !world || data.running; $('pause').disabled = !data.running; $('cancel').disabled = !data.running;
  text($('updated'), world?.updatedAt ? `更新于 ${new Date(world.updatedAt).toLocaleTimeString()}` : '等待数据');
  if (world?.lastError) text($('message'), world.lastError);
}

async function post(endpoint, body) {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DSH-Control': '1' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

async function setMode(mode) {
  try {
    await post('/api/mode', { mode });
    text($('message'), `已切换到${mode === 'native' ? '普通对话' : '自主项目'}模式。`);
  } catch (error) { text($('message'), error.message); }
}

$('mode-native')?.addEventListener('click', () => setMode('native'));
$('mode-project')?.addEventListener('click', () => setMode('project'));

// Native chat
const nativeMessages = $('native-messages');
function appendNative(role, content) {
  const bubble = node('div', undefined, `chat-bubble ${role}`);
  bubble.append(node('strong', role === 'user' ? '你' : 'DSH'), node('p', content));
  nativeMessages.append(bubble);
  nativeMessages.scrollTop = nativeMessages.scrollHeight;
}

$('native-form')?.addEventListener('submit', async event => {
  event.preventDefault();
  const prompt = $('native-prompt').value.trim();
  if (!prompt) return;
  appendNative('user', prompt);
  $('native-prompt').value = '';
  try {
    $('native-send').disabled = true;
    const start = !nativeConnected;
    if (start) {
      const provider = $('native-provider').value.trim();
      const model = $('native-model').value.trim();
      if (!provider || !model) {
        text($('message'), '请选择已启用的 Provider 和 Model。');
        return;
      }
      await post('/api/native/start', {
        provider,
        model,
      });
    }
    await post('/api/native/chat', { prompt });
  } catch (error) { text($('message'), error.message); }
  finally { await fetch('/api/state').then(response => response.json()).then(render).catch(() => {}); }
});

$('native-stop')?.addEventListener('click', async () => {
  try { await post('/api/native/stop', {}); }
  catch (error) { text($('message'), error.message); }
});

// Native SSE
const nativeStream = new EventSource('/api/native/events');
nativeStream.onmessage = event => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'message' && msg.data.delta) {
    const last = nativeMessages.lastElementChild;
    if (last && last.classList.contains('assistant')) {
      const p = last.querySelector('p');
      p.textContent += msg.data.delta;
    } else {
      appendNative('assistant', msg.data.delta);
    }
    nativeMessages.scrollTop = nativeMessages.scrollHeight;
  }
  if (msg.type === 'done') {
    const last = nativeMessages.lastElementChild;
    if (last && last.classList.contains('assistant')) last.classList.add('done');
  }
  if (['ready', 'done', 'error', 'stopped', 'close'].includes(msg.type)) fetch('/api/state').then(response => response.json()).then(render).catch(() => {});
  if (msg.type === 'error') text($('message'), `Native session error: ${msg.data.message ?? 'unknown'}`);
};
nativeStream.onerror = () => text($('connection'), '连接中断 · 自动重连');

// Setup form
$('setup-form')?.addEventListener('submit', async event => {
  event.preventDefault();
  const lines = id => $(id).value.split('\n').map(s => s.trim()).filter(Boolean);
  try {
    const config = {
      goal: $('setup-goal').value.trim(),
      repository: $('setup-repository').value.trim(),
      stateDir: $('setup-stateDir').value.trim(),
      successCriteria: lines('setup-successCriteria'),
      constraints: lines('setup-constraints'),
      protectedPaths: lines('setup-protectedPaths'),
      tests: [{ executable: $('setup-testExecutable').value.trim(), args: JSON.parse($('setup-testArgs').value) }],
      maxActions: Number($('setup-maxActions').value),
      agentTimeoutMs: Number($('setup-agentTimeoutMs').value),
      testTimeoutMs: Number($('setup-testTimeoutMs').value),
      commercialLoop: { enabled: $('setup-commercialLoop').checked },
    };
    await post('/api/project/setup', config);
    text($('message'), '项目配置已保存。');
  } catch (error) { text($('message'), error.message); }
});

// Project controls
for (const action of ['start', 'pause', 'cancel']) $(action)?.addEventListener('click', async () => {
  try {
    const response = await fetch(`/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DSH-Control': '1' }, body: JSON.stringify(action === 'start' ? { maxActions: Number($('budget').value) } : {}) });
    const result = await response.json();
    text($('message'), result.error ?? (action === 'pause' ? '将在本次行动及审核结束后暂停。' : action === 'cancel' ? '已请求终止当前运行。' : 'Loop 已启动。'));
    const data = await (await fetch('/api/state')).json(); render(data);
  } catch { text($('message'), '控制请求失败，请检查连接。'); }
});

const stream = new EventSource('/api/events');
stream.onmessage = event => { text($('connection'), '已连接'); render(JSON.parse(event.data)); };
stream.onerror = () => text($('connection'), '连接中断 · 自动重连');
fetch('/api/state').then(response => response.json()).then(render).catch(() => text($('message'), '无法连接本地服务。'));
