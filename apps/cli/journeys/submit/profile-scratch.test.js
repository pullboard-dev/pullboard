/** Concurrent submit phases retain independent raw receipts and refuse either red result [V4,C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateRepo } from '../../tests/fixtures/submit/gate.js';
import { builderRepo } from '../../tests/fixtures/submit/gate.js';
import { commitAll } from '../../tests/fixtures/submit/gate.js';
import { put } from '../../tests/fixtures/submit/gate.js';

// Budget: two deliberately twenty-second fixture checks must overlap; the whole CLI gets only 20% overhead.
const SLOW_MS = 20_000;

/** A real CLI submission with independently timed criterion and final-proof child commands. */
function project(t, delay) {
  const main = privateRepo(t);
  const observations = join(main.dir, 'observations.jsonl');
  const command = role => `PARALLEL_ROLE=${role} PARALLEL_DELAY=${delay} PARALLEL_OBSERVATIONS='${observations}' node --test --test-reporter=./test/reporter.mjs test/check.test.mjs`;
  put(main.root, 'pullboard.json', JSON.stringify({ gate: command('proof'), shared: ['pullboard.json'] }));
  put(main.root, 'src/a.js', 'export const value = 1;\n');
  put(main.root, 'test/check.test.mjs', `import { appendFileSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const role = process.env.PARALLEL_ROLE ?? 'proof';
test(role, async () => {
  const start = Date.now();
  await new Promise(resolve => setTimeout(resolve, Number(process.env.PARALLEL_DELAY ?? 0)));
  const failed = readFileSync('src/a.js', 'utf8').includes('fail-' + role);
  if (process.env.PARALLEL_OBSERVATIONS) appendFileSync(process.env.PARALLEL_OBSERVATIONS, JSON.stringify({ role, start, end: Date.now(), failed }) + '\\n');
  assert.equal(failed, false);
});
`);
  put(main.root, 'test/reporter.mjs', `import { tap } from 'node:test/reporters';
import { relative } from 'node:path';
export default async function* report(events) {
  const rows = [];
  async function* observe() {
    for await (const event of events) {
      if (['test:pass', 'test:fail'].includes(event.type) && event.data.file && event.data.details?.type !== 'suite') {
        rows.push({ file: relative(process.cwd(), event.data.file), name: event.data.name,
          passed: event.type === 'test:pass', skipped: event.data.skip !== undefined || event.data.todo !== undefined });
      }
      yield event;
    }
  }
  yield* tap(observe());
  if (process.env.PULLBOARD_TIMING_RUN_ID) for (const row of rows) {
    yield '# pullboard test outcomes ' + JSON.stringify({ version: 1, id: process.env.PULLBOARD_TIMING_RUN_ID, tests: [row] }) + '\\n';
  }
}
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

test('PROFILE fixed overhead of submit with instant checks [V4,C7]', { timeout: 170_000 }, t => {
  for (const delay of [0, 0]) {
    const t0 = Date.now();
    const { box } = project(t, delay);
    const setup = Date.now() - t0;
    const { result, wallMs } = submit(box, 'green' + delay + Math.random());
    console.error('PROFILE delay=' + delay + ' setup=' + setup + ' submitWall=' + wallMs + ' code=' + result.code);
    console.error('PROFILE stages ' + (result.out + result.err).split('\n').filter(l => /submit [a-z ]+: [0-9.]+s/u.test(l)).join(' | '));
  }
});
