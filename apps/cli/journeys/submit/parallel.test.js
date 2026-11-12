/** Concurrent submit phases overlap within 20% overhead and keep independent raw receipts [V4,C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { project } from '../../tests/fixtures/submit/parallel.js';
import { submit } from '../../tests/fixtures/submit/parallel.js';

// Budget: two deliberately twenty-second fixture checks must overlap; the whole CLI gets only 20% overhead.
const SLOW_MS = 20_000;

test('submit overlaps two slow checks within 20% of the slower one and preserves both receipts [V4,C7]', { timeout: 120_000 }, t => { // budget: a twenty-second check also runs once at add for its frozen baseline.
  const { box, observations } = project(t, SLOW_MS);
  const { result, wallMs, receipts } = submit(box, 'green');
  assert.equal(result.code, 0, result.err + result.out);
  const runs = readFileSync(observations, 'utf8').trim().split('\n').map(line => JSON.parse(line)).slice(-2);
  assert.deepEqual(new Set(runs.map(run => run.role)), new Set(['criterion', 'proof']));
  assert.ok(Math.max(...runs.map(run => run.start)) < Math.min(...runs.map(run => run.end)), 'the real child intervals overlap');
  const slower = Math.max(...runs.map(run => run.end - run.start));
  const where = (result.err + result.out).split('\n').filter(line => /^submit [^:]+: [0-9.]+s$/u.test(line)).map(line => line.slice(7)).join('; ');
  t.diagnostic(`submit ${wallMs}ms; check receipts ${receipts.map(receipt => receipt.durationMs).join(',')}ms; stages ${where}`);
  assert.ok(wallMs <= slower * 1.2, `submit ${wallMs}ms, slower check ${slower}ms; receipts ${receipts.map(receipt => receipt.durationMs).join(',')}ms; stages ${where}`);
  assert.equal(receipts.length, 2, 'each command retains its own native proof receipt');
  assert.equal(new Set(receipts.map(receipt => receipt.id)).size, 2);
  assert.ok(receipts.every(receipt => receipt.exitCode === 0 && receipt.environment?.node === process.versions.node));
});
