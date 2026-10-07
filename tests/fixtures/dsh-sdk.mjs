// Fake DSH SDK stdio transport for native session tests.
process.stdin.setEncoding('utf8');
let pending = '';
let currentSessionId = 'unknown';
const line = object => process.stdout.write(JSON.stringify(object) + '\n');

function event(type, data) {
  line({ jsonrpc: '2.0', method: 'session.event', params: { sessionId: currentSessionId, event: { type, data } } });
}

process.stdin.on('data', chunk => {
  pending += chunk;
  let index;
  while ((index = pending.indexOf('\n')) >= 0) {
    const value = JSON.parse(pending.slice(0, index)); pending = pending.slice(index + 1);
    if (value.method === 'initialize') {
      if (process.env.DSH_SDK_FAIL === 'init') {
        line({ jsonrpc: '2.0', id: value.id, error: { message: 'SDK initialization failed: no authorized model' } });
        continue;
      }
      line({ jsonrpc: '2.0', id: value.id, result: { serverInfo: { name: 'dsh-native-fixture' } } });
    }
    if (value.method === 'session/prompt') {
      if (process.env.DSH_SDK_FAIL === 'prompt') {
        line({ jsonrpc: '2.0', id: value.id, error: { message: 'Prompt rejected: selected model is not authorized' } });
        continue;
      }
      currentSessionId = value.params.sessionId ?? currentSessionId;
      const prompt = value.params.contentBlocks?.map(b => b.text).join('') ?? '';
      if (process.env.DSH_SDK_FAIL === 'turn') {
        event('turn/end', { reason: { kind: 'error' } });
        continue;
      }
      if (process.env.DSH_SDK_SLOW) {
        setTimeout(() => {
          event('assistant/message', { message: { content: [{ type: 'text', text: `Slow response to: ${prompt.slice(0, 20)}` }] } });
          event('turn/end', { reason: { kind: 'completed' } });
        }, 5000);
        continue;
      }
      event('assistant/message', { message: { content: [{ type: 'text', text: `Fixture response to: ${prompt.slice(0, 20)}` }] } });
      event('turn/end', { reason: { kind: 'completed' } });
    }
  }
});
