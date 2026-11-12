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
  const { result, started, wallMs, receipts } = submit(box, 'green');
  assert.equal(result.code, 0, result.err + result.out);
  const runs = readFileSync(observations, 'utf8').trim().split('\n').map(line => JSON.parse(line)).slice(-2);
  assert.deepEqual(new Set(runs.map(run => run.role)), new Set(['criterion', 'proof']));
  assert.ok(Math.max(...runs.map(run => run.start)) < Math.min(...runs.map(run => run.end)), 'the real child intervals overlap');
  assert.equal(receipts.length, 2, 'each command retains its own native proof receipt');
  // The slower check is the slower command as its receipt timed it, its own node --test start included; the inner
  // sleep is only the floor. Either way the overhead left is submit's own, and two serial checks would double it (#5752).
  const slower = Math.max(...receipts.map(receipt => receipt.durationMs));
  assert.ok(slower >= Math.max(...runs.map(run => run.end - run.start)), `the receipt times the whole check: ${slower}ms`);
  const where = `before the checks ${Math.min(...runs.map(run => run.start)) - started}ms, after them ${started + wallMs - Math.max(...runs.map(run => run.end))}ms; ${((result.err + result.out).match(/submit [a-z -]+: [0-9.]+s at [0-9]+/gu) ?? []).join(', ')}`;
  t.diagnostic(`submit ${wallMs}ms; slower check ${slower}ms; ${where}`);
  assert.ok(wallMs <= slower * 1.2, `submit ${wallMs}ms, slower check ${slower}ms; ${where}`);
  assert.equal(new Set(receipts.map(receipt => receipt.id)).size, 2);
  assert.ok(receipts.every(receipt => receipt.exitCode === 0 && receipt.environment?.node === process.versions.node));
});
