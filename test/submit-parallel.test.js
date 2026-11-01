/** Concurrent submit phases retain independent raw receipts and refuse either red result [V4,C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateRepo } from './submit-gate-fixture.js';
import { builderRepo } from './submit-gate-fixture.js';
import { commitAll } from './submit-gate-fixture.js';
import { put } from './submit-gate-fixture.js';

// Budget: two deliberately twenty-second fixture checks must overlap; the whole CLI gets only 20% overhead.
const SLOW_MS = 20_000;

/** A real CLI submission with independently timed criterion and final-proof child commands. */
function project(t, delay) {
  const main = privateRepo(t);
  const observations = join(main.dir, 'observations.jsonl');
  const command = role => `node test/check.mjs ${role} ${delay} '${observations}'`;
  put(main.root, 'pullboard.json', JSON.stringify({ gate: command('proof'), shared: ['pullboard.json'] }));
  put(main.root, 'src/a.js', 'export const value = 1;\n');
  put(main.root, 'test/check.mjs', `import { appendFileSync, readFileSync } from 'node:fs';
const [role, delay, observations] = process.argv.slice(2);
const start = Date.now();
await new Promise(resolve => setTimeout(resolve, Number(delay)));
const failed = readFileSync('src/a.js', 'utf8').includes('fail-' + role);
appendFileSync(observations, JSON.stringify({ role, start, end: Date.now(), failed }) + '\\n');
console.log('TAP version 13\\n1..1\\n' + (failed ? 'not ok' : 'ok') + ' 1 - ' + role);
process.exitCode = failed ? 1 : 0;
`);
  commitAll(main);
  const box = builderRepo(main);
  assert.equal(box.coordinator('add', 'build', 'Parallel submit fixture', '--check', command('criterion')).code, 0);
  assert.equal(box.run('claim', '1').code, 0);
  return { box, observations };
}

/** Submit a new candidate and return its native per-command proof receipts. */
function submit(box, marker) {
  put(box.root, 'src/a.js', `export const value = '${marker}';\n`);
  commitAll(box, 'feat(core): exercise the selected phase [G1]');
  const started = Date.now();
  const result = box.run('submit', '1', '--json', '--infra', 'concurrent fixture checks');
  const wallMs = Date.now() - started;
  const item = JSON.parse(box.run('show', '1', '--json').out);
  return { result, wallMs, receipts: (item.proofReceipts ?? []).filter(receipt => receipt.kind === 'submit') };
}

test('submit overlaps two slow checks within 20% of the slower one and preserves both receipts [V4,C7]', { timeout: 120_000 }, t => { // budget: a twenty-second check also runs once at add for its frozen baseline.
  const { box, observations } = project(t, SLOW_MS);
  const { result, wallMs, receipts } = submit(box, 'green');
  assert.equal(result.code, 0, result.err + result.out);
  const runs = readFileSync(observations, 'utf8').trim().split('\n').map(line => JSON.parse(line)).slice(-2);
  assert.deepEqual(new Set(runs.map(run => run.role)), new Set(['criterion', 'proof']));
  assert.ok(Math.max(...runs.map(run => run.start)) < Math.min(...runs.map(run => run.end)), 'the real child intervals overlap');
  const slower = Math.max(...runs.map(run => run.end - run.start));
  assert.ok(wallMs <= slower * 1.2, `submit ${wallMs}ms, slower check ${slower}ms`);
  assert.equal(receipts.length, 2, 'each command retains its own native proof receipt');
  assert.equal(new Set(receipts.map(receipt => receipt.id)).size, 2);
  assert.ok(receipts.every(receipt => receipt.exitCode === 0 && receipt.environment.node === '22.22.2'));
});

for (const role of ['criterion', 'proof']) {
  test(`a red ${role} refuses submit and retains both independent raw receipts [V4,C7]`, t => {
    const { box } = project(t, 25);
    const { result, receipts } = submit(box, `fail-${role}`);
    assert.notEqual(result.code, 0, result.out);
    assert.match(result.err + result.out, /GATE_RED/u);
    assert.equal(receipts.length, 2, 'the passing sibling also finishes and records its result');
    assert.deepEqual(receipts.map(receipt => receipt.exitCode).toSorted(), [0, 1]);
    assert.equal(new Set(receipts.map(receipt => receipt.id)).size, 2);
  });
}
