/** The signed receipt body stamps the sha256 of the package-lock.json a job installed from, beside its commit and tree [C7,#1112]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { lockfileHash } from '../../../src/io/worker/checkout.js';
import { receipt } from '../../../src/io/worker/receipt.js';

/** Send one receipt for a fixture job and return the body it printed. */
async function sent(fields) {
  const spec = { id: 'job-1', commit: 'c'.repeat(40), tree: 't'.repeat(40), runtime: { sha256: 'r' }, tooling: { sha256: 'u' } };
  const sink = { hash: createHash('sha256'), wallStart: Date.now() };
  const original = process.stderr.write;
  let line = '';
  process.stderr.write = (chunk, ...rest) => { line += String(chunk); const done = rest.find(arg => typeof arg === 'function'); if (done) done(); return true; };
  try { await receipt(spec, { code: 0, signal: null, executionPhases: {}, ...fields }, sink); } finally { process.stderr.write = original; }
  return JSON.parse(Buffer.from(line.trim().split(' ')[2], 'base64').toString('utf8'));
}

test('runner.worker-receipt.dependency-hash: clause 1: the signed receipt body carries dependencies, the sha256 of the lockfile bytes installed from, beside the commit and tree [C7,#1112]', async t => {
  const { root, write } = privateFixtureFiles('pullboard-receipt-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write('package-lock.json', '{"lockfileVersion":3}\n');
  const hash = createHash('sha256').update('{"lockfileVersion":3}\n').digest('hex');
  assert.equal(lockfileHash(root), hash);
  const body = await sent({ dependencies: lockfileHash(root) });
  assert.equal(body.dependencies, hash);
  assert.equal(body.commit, 'c'.repeat(40));
  assert.equal(body.tree, 't'.repeat(40));
});

test('runner.worker-receipt.no-lockfile-stamps-none: clause 2: a tree with no package-lock.json stamps dependencies none, and identical lockfile bytes stamp the same hash [C7,#1112]', async t => {
  const first = privateFixtureFiles('pullboard-receipt-');
  const second = privateFixtureFiles('pullboard-receipt-');
  const bare = privateFixtureFiles('pullboard-receipt-');
  t.after(() => { for (const { root } of [first, second, bare]) rmSync(root, { recursive: true, force: true }); });
  first.write('package-lock.json', 'same bytes');
  second.write('package-lock.json', 'same bytes');
  assert.equal(lockfileHash(first.root), lockfileHash(second.root));
  assert.equal(lockfileHash(bare.root), 'none');
  assert.equal((await sent({ dependencies: lockfileHash(bare.root) })).dependencies, 'none');
  assert.equal((await sent({})).dependencies, 'none');
});
