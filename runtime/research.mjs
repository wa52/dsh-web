import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  return isIP(address) === 6 && /^2[0-9a-f]{3}:/i.test(address) && !/^2001:db8:/i.test(address);
}

/** Host-only public GET: DNS pinned, no credentials/query, no redirect follow. */
export async function readBenchmark(ref) {
  const url = new URL(ref.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || (url.port && url.port !== '443')) throw new Error('Benchmark must be a public HTTPS URL without credentials or query');
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(entry => !publicAddress(entry.address))) throw new Error('Benchmark resolves to a non-public address');
  const pinned = addresses[0];
  const html = await new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'DSH-Web-Research/1.0', Accept: 'text/html,text/plain' }, lookup: (_hostname, options, callback) => callback(null, options?.all ? [pinned] : pinned.address, pinned.family) }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`Benchmark HTTP ${res.statusCode}; redirects are not followed`)); return; }
      const chunks = []; let bytes = 0;
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 512000) { res.destroy(new Error('Benchmark document exceeds 512KB budget')); return; } chunks.push(chunk); });
      res.on('error', reject); res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.setTimeout(15000, () => req.destroy(new Error('Benchmark request timed out')));
    const deadline = setTimeout(() => req.destroy(new Error('Benchmark total time budget exceeded')), 15000);
    req.once('close', () => clearTimeout(deadline));
    req.on('error', reject);
  });
  const plain = html.replace(/<(script|style|nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&(?:nbsp|amp|quot|lt|gt);/g, ' ').replace(/\s+/g, ' ').trim();
  return { ...ref, retrievedAt: new Date().toISOString(), truncated: plain.length > 16000, text: plain.slice(0, 16000) };
}
