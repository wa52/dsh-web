// Protocol fixture only: validates adapters without model calls or credentials.
import { writeFileSync, readFileSync } from 'node:fs';
const provider = process.env.DSH_PROTOCOL_FIXTURE;
const args = process.argv.slice(2);
const line = object => process.stdout.write(JSON.stringify(object) + '\n');
if (provider === 'codex') {
  if (process.env.DSH_PROTOCOL_QUOTA) {
    line({ type: 'error', message: 'Usage limit exceeded' });
  } else {
  const target = args[args.indexOf('-o') + 1];
  writeFileSync(target, JSON.stringify({ summary: 'protocol-ok', args, codexEnvironmentKeys: Object.keys(process.env).filter(key => /^CODEX_/i.test(key)) }));
  line({ type: 'turn.completed' });
  }
} else if (provider === 'opencode') {
  if (process.env.DSH_PROTOCOL_QUOTA) {
    line({ type: 'error', error: { message: 'Usage limit exceeded' } });
  } else {
  const prompt = args.flatMap((arg, index) => arg === '--file' ? [readFileSync(args[index + 1], 'utf8')] : []).join('');
  line({ type: 'text', part: { text: JSON.stringify({ summary: 'protocol-ok', prompt, args }) } });
  }
} else {
  process.stdin.setEncoding('utf8'); let pending = '';
  process.stdin.on('data', chunk => {
    pending += chunk;
    let index;
    while ((index = pending.indexOf('\n')) >= 0) {
      const value = JSON.parse(pending.slice(0, index)); pending = pending.slice(index + 1);
      if (provider === 'pi' && value.type === 'prompt') {
        line({ type: 'response', id: value.id, success: true });
        line({ type: 'agent_end', willRetry: false, messages: [{ role: 'assistant', content: [{ type: 'text', text: '{"summary":"protocol-ok"}' }], stopReason: 'stop' }] });
      }
      if (provider === 'dsh') {
        if (value.method === 'initialize') line({ jsonrpc: '2.0', id: value.id, result: { serverInfo: { name: 'protocol-fixture' } } });
        if (value.method === 'session/prompt') {
          const event = (type, data) => line({ jsonrpc: '2.0', method: 'session.event', params: { sessionId: value.params.sessionId, event: { type, data } } });
          event('assistant/message', { message: { content: [{ type: 'text', text: '{"summary":"protocol-ok"}' }] } });
          event('turn/end', { reason: { kind: 'completed' } });
        }
      }
    }
  });
}
