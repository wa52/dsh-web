// Local JSON-RPC fixture: record trusted native launch settings without a model call.
import { writeFileSync } from 'node:fs';

const write = value => process.stdout.write(`${JSON.stringify(value)}\n`);
process.stdin.setEncoding('utf8');
let pending = '';
process.stdin.on('data', chunk => {
  pending += chunk;
  let index;
  while ((index = pending.indexOf('\n')) >= 0) {
    const request = JSON.parse(pending.slice(0, index));
    pending = pending.slice(index + 1);
    if (request.method === 'initialize') {
      writeFileSync(process.env.DSH_NATIVE_SETTINGS_FILE, JSON.stringify({
        params: request.params,
        args: process.argv.slice(2),
        cwd: process.cwd(),
      }));
      write({ jsonrpc: '2.0', id: request.id, result: { serverInfo: { name: 'local-settings-fixture' } } });
    } else if (request.method === 'session/prompt') {
      const sessionId = request.params.sessionId;
      const text = { type: 'text', text: 'fixture response' };
      write({
        jsonrpc: '2.0', method: 'session.event',
        params: { sessionId, event: { type: 'assistant/message', data: { message: { content: [text] } } } },
      });
      write({
        jsonrpc: '2.0', method: 'session.event',
        params: { sessionId, event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } },
      });
    }
  }
});
