/** @pullboard-test-loads apps/cli/src/io/entry.js apps/cli/src/io/next/monitor.js */
/** Eval callers retain real CLI progress and every non-input-type Worker flag [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runFixtureChildAsync } from '../../tests/fixtures/child.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

const CLI = new URL('../../tests/fixtures/native.js', import.meta.url).href;

/** Prepare an ordinary private joined seat and record the actual parent and Worker argument vectors. */
async function evalProject(t, { failWorker = false } = {}) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true', helpers.sandbox({ declareFamilies: true }));
  const added = fixtureAdd(box.run, box.repo, 'web', 'Eval progress claim', '--specs', 'G1',
    '--criterion', 'The real joined seat claims this item.', '--check', 'true', '--json');
  assert.equal(added.code, 0, added.err);
  const id = JSON.parse(added.out).item.item_id;
  const inbox = (await box.runLocal(box.web, 'inbox', '--json'));
  assert.equal(inbox.code, 0, inbox.err);
  const observation = join(box.dir, 'monitor-arguments.jsonl');
  const preload = join(box.dir, 'monitor-preload.cjs');
  writeFileSync(preload, `const { appendFileSync } = require('node:fs');
const { isMainThread } = require('node:worker_threads');
appendFileSync(${JSON.stringify(observation)}, JSON.stringify({ isMainThread, execArgv: process.execArgv }) + '\\n');
if (!isMainThread && ${JSON.stringify(failWorker)}) throw new Error('owned monitor preload failure');
`);
  return { ...box, id, observation, preload };
}

/** Run the actual CLI entry with its real streams, so the progress Worker is required rather than an adapter fallback. */
function nextFromEval(box, inputType) {
  const code = `const { main } = await import(${JSON.stringify(CLI)});
process.exitCode = await main(process.argv.slice(1), {
  cwd: process.cwd(), stdin: process.stdin, stdout: process.stdout, stderr: process.stderr,
});`;
  // Process-level case, kept: the progress Worker needs the real process streams and a --require preload.
  return runFixtureChildAsync(process.execPath,
    ['--no-warnings', '--require', box.preload, ...inputType, '-e', code, 'next', '--build', '--json'],
    { cwd: box.web, env: box.env, encoding: 'utf8' });
}

for (const [label, inputType] of [['joined', ['--input-type=module']], ['separate', ['--input-type', 'module']]]) {
  test(`an ${label} eval input type starts the real next Worker without dropping other flags [C7]`, async t => {
    const box = await evalProject(t);
    const result = await nextFromEval(box, inputType);
    assert.equal(result.status, 0, result.failure ?? result.stderr);
    const selected = JSON.parse(result.stdout);
    assert.equal(selected.item.item_id, box.id);
    assert.equal(selected.item.item_owner, 'web-1');
    const records = readFileSync(box.observation, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const parent = records.find(record => record.isMainThread);
    const workers = records.filter(record => !record.isMainThread);
    assert.ok(parent, 'the actual CLI parent loaded the requested preload');
    assert.equal(workers.length, 1, 'the real next progress Worker also ran that unchanged preload');
    const expected = [...parent.execArgv];
    const start = expected.indexOf(inputType[0]);
    assert.ok(start >= 0);
    expected.splice(start, inputType.length);
    assert.deepEqual(workers[0].execArgv, expected, 'only the input-type flag and its own value are removed');
    assert.ok(workers[0].execArgv.includes('--no-warnings'));
    assert.ok(workers[0].execArgv.includes(box.preload));
  });
}

test('an actual next Worker preload failure remains loud and cannot claim the pending item [C7]', async t => {
  const box = await evalProject(t, { failWorker: true });
  const result = await nextFromEval(box, ['--input-type=module']);
  assert.equal(result.status, 1, result.failure ?? result.stderr);
  assert.match(result.stdout + result.stderr, /owned monitor preload failure/u);
  const shown = (await box.runLocal(box.web, 'show', String(box.id), '--json'));
  assert.equal(shown.code, 0, shown.err);
  const item = JSON.parse(shown.out);
  assert.equal(item.item_status, 'open');
  assert.equal(item.item_owner, null, 'startup failure cannot silently continue native routing');
});
