import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const world = JSON.parse(await readFile(process.argv[2], 'utf8'));
const tree = world.actions.findLast(action => action.phase === 'MERGE_READY')?.worktree.directory;
if (!tree) throw new Error('No reviewed fixture candidate');
const port = Number(process.argv[3] ?? 4782);
const files = { '/': ['index.html', 'text/html'], '/style.css': ['style.css', 'text/css'], '/checkout.mjs': ['checkout.mjs', 'text/javascript'] };
http.createServer(async (req, res) => {
  const file = files[req.url];
  if (!file) { res.writeHead(404); res.end(); return; }
  try { res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8`, 'Cache-Control': 'no-store' }); res.end(await readFile(path.join(tree, file[0]))); }
  catch { res.end(); }
}).listen(port, '127.0.0.1', () => console.log(`Reviewed fixture: http://127.0.0.1:${port}`));
