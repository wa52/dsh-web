// Host-owned external acceptance for the new-project harness. It runs with cwd
// set to the product worktree by the Runtime's Host test runner, but the file
// itself lives outside the product repository so the Builder cannot edit it.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const target = pathToFileURL(path.join(process.cwd(), 'pricing.mjs')).href;
const { subtotal, quote } = await import(target);

assert.equal(typeof subtotal, 'function', 'pricing.mjs must export subtotal');
assert.equal(typeof quote, 'function', 'pricing.mjs must export quote');

assert.equal(subtotal([]), 0);
assert.equal(subtotal([{ price: 5, quantity: 3 }, { price: 2, quantity: 1 }]), 17);

const empty = quote([]);
assert.equal(empty.subtotal, 0);
assert.equal(empty.shipping, 0);
assert.equal(empty.total, 0);

const paid = quote([{ price: 10, quantity: 3 }]);
assert.equal(paid.subtotal, 30);
assert.equal(paid.shipping, 5);
assert.equal(paid.total, 35);

const free = quote([{ price: 20, quantity: 3 }]);
assert.equal(free.subtotal, 60);
assert.equal(free.shipping, 0);
assert.equal(free.total, 60);

console.log('new-project acceptance: pricing.mjs behavior verified');
