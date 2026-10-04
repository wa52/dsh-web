import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

/** Deliberately broken project, not a TODO plan for the controller. */
export async function createCheckoutFixture(repository) {
  await mkdir(path.join(repository, 'tests'), { recursive: true });
  await writeFile(path.join(repository, 'package.json'), '{"type":"module"}\n');
  await writeFile(path.join(repository, 'checkout.mjs'), `export const total = items => items.reduce((sum, item) => sum + item.price, 0);\nexport const delivery = items => items.reduce((sum, item) => sum + item.price, 0) >= 30 ? 0 : 5;\n`);
  await writeFile(path.join(repository, 'style.css'), '.checkout { display: none; padding: 16px; }\n');
  await writeFile(path.join(repository, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1>Checkout</h1><button class="checkout">Pay now</button></body></html>\n');
  await writeFile(path.join(repository, 'tests/acceptance.test.mjs'), `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\nimport { total, delivery } from '../checkout.mjs';\nconst items = [{ price: 10, quantity: 3 }];\ntest('functional: totals include quantity', () => assert.equal(total(items), 30));\ntest('ui: checkout button is visible', () => assert.doesNotMatch(readFileSync(new URL('../style.css', import.meta.url), 'utf8'), /display\\s*:\\s*none/));\ntest('regression: free delivery after correct total', t => { if (total(items) !== 30) { t.skip('blocked by incorrect subtotal'); return; } assert.equal(delivery(items), 0); });\n`);
  const git = args => execFileSync('git', ['-C', repository, ...args], { stdio: 'pipe' });
  git(['init', '-b', 'main']); git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgSign=false', 'commit', '-m', 'Seed functional, UI and latent regression defects']);
  return { repository, goal: 'Make checkout totals, delivery pricing and the checkout interface correct', successCriteria: ['Quantities contribute to order totals', 'The checkout button is visible', 'Orders with subtotal at least 30 receive free delivery', 'All acceptance tests pass without editing acceptance tests'] };
}
