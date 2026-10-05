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

/**
 * Brief-only new-project seed: a product README plus an initial commit and no
 * application source. Naming the required interface is a product requirement,
 * not a pre-seeded implementation; the Loop builds the product natively later.
 */
export async function createBriefFixture(repository) {
  await mkdir(repository, { recursive: true });
  await writeFile(path.join(repository, 'package.json'), '{"type":"module"}\n');
  await writeFile(path.join(repository, 'README.md'), [
    '# Product brief — Order quote',
    '',
    'Build the product described here. The repository intentionally contains only this',
    'brief; create the implementation from scratch.',
    '',
    '## Product',
    '',
    'A reusable order-quote capability for a small storefront. A shopper supplies a',
    'list of line items, and the product reports the subtotal, the shipping fee and the total.',
    '',
    '## Required interface',
    '',
    '- Implement an ES module at `pricing.mjs` using Node.js built-ins only.',
    '  Do not add runtime dependencies and do not rely on network access.',
    '- Each line item is an object `{ price: number, quantity: number }`.',
    '- Export `subtotal(items)`: returns the sum of `price * quantity` for every item,',
    '  and `0` for an empty list.',
    '- Export `quote(items)`: returns an object `{ subtotal, shipping, total }` where',
    '  `shipping` is `0` when `subtotal` is at least `50` and `5` otherwise, and `total`',
    '  is `subtotal + shipping`. An empty list returns `{ subtotal: 0, shipping: 0, total: 0 }`.',
    '- Keep amounts as plain numbers; do not return formatted currency strings.',
    '',
    '## Core journey',
    '',
    'A shopper adds items with quantities, then sees the correct subtotal, the correct',
    'shipping fee and the correct final total for both the free-shipping and the',
    'paid-shipping case.',
    '',
  ].join('\n'));
  const git = args => execFileSync('git', ['-C', repository, ...args], { stdio: 'pipe' });
  git(['init', '-b', 'main']);
  git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgSign=false', 'commit', '-m', 'Product brief only']);
  return {
    repository,
    goal: 'Develop the order-quote product described in the repository README',
    successCriteria: [
      'pricing.mjs exports subtotal and quote with the behavior defined in the product brief',
      'The external Host acceptance passes against the generated product',
      'Independent review reports no blocking issues',
    ],
  };
}

/**
 * Host-side configuration for the native new-project acceptance harness. The
 * external Host acceptance lives outside the product repository so the Builder
 * cannot define its own success, and references carry Host-supplied text so the
 * alignment gate has a verified source without network access.
 */
export function newProjectConfig(fixture, { root, acceptance, options = {} }) {
  return {
    ...fixture,
    stateDir: path.join(root, 'state'),
    constraints: [
      'Never rewrite the product brief README',
      'Do not modify or add Host acceptance tests',
      'Keep main untouched',
    ],
    permissions: options.permissions ?? { shell: false, network: false },
    protectedPaths: ['README.md'],
    tests: [{ executable: process.execPath, args: [acceptance] }],
    commercialLoop: {
      enabled: true,
      worker: 'opencode',
      maxAlignmentAttempts: options.maxAlignmentAttempts ?? 2,
      references: [{
        url: 'https://example.com/new-project-brief',
        title: 'Host-supplied bounded acceptance reference',
        text: 'Host-supplied fixture text, not a real market benchmark: an order quote reports a subtotal, a shipping fee that is free at or above a threshold, and their sum.',
      }],
    },
    decisionAgent: options.decisionAgent ?? 'auto',
    maxActions: options.maxActions ?? 4,
    agentTimeoutMs: options.agentTimeoutMs ?? 180_000,
  };
}
