const $ = id => document.getElementById(id);
const phases = ['OBSERVE', 'DECIDE', 'DISPATCH', 'BUILD', 'REVIEW', 'UPDATE', 'REPLAN', 'STOP'];
const text = (element, value) => { element.textContent = value ?? '—'; };
const node = (tag, value, className) => { const element = document.createElement(tag); if (value !== undefined) text(element, value); if (className) element.className = className; return element; };
let latest;

function render(data) {
  latest = data;
  const world = data.world;
  const activePhase = world?.phase === 'REVIEW_REQUIRED' ? 'REVIEW' : world?.phase ?? 'STOP';
  text($('goal'), world?.goal ?? '配置一个项目，开始观察');
  text($('repository'), world?.project.repository ?? '使用 npm start -- --config project.json 连接项目。');
  text($('health'), world ? `${Math.round(world.projectHealth * 100)}%` : '—');
  text($('status'), world?.status ?? '未配置'); text($('phase-label'), world?.phase ?? 'STOP');
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

for (const action of ['start', 'pause', 'cancel']) $(action).addEventListener('click', async () => {
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
