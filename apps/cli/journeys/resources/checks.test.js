/** @pullboard-test-input apps/cli/pullboard.js */
/** @pullboard-test-loads apps/cli/src/io/entry.js */
/** Resource queue check cases: a browser-free check does not wait for the browser slot [Q1,Q2,Q4,C7]. */
import assert from 'node:assert/strict';
import { runFixtureChildAsync } from '../../tests/fixtures/child.js';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { checkNeedsBrowser } from '../../../../packages/gate/index.js';
import { awaitNestedPhase } from '../../../../packages/gate/index.js';
import { checkProject } from '../../../../packages/gate/tests/fixtures/resources/verify.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { SUBMIT_CHECK } from '../../tests/fixtures/resources/pool.js';
import { acquired } from '../../tests/fixtures/resources/pool.js';
import { fixture } from '../../tests/fixtures/resources/pool.js';
import { poolWorker } from '../../tests/fixtures/resources/pool.js';
import { privateList } from '../../tests/fixtures/resources/pool.js';
import { release } from '../../tests/fixtures/resources/pool.js';
import { setBrowserFreeChecks } from '../../tests/fixtures/resources/pool.js';
import { waitForMarker } from '../../tests/fixtures/resources/pool.js';
import { waitUntil } from '../../tests/fixtures/resources/pool.js';

const BIN = resolve(import.meta.dirname, '../../pullboard.js');
/** Run the production CLI in this process against a pool fixture's private environment, from `cwd` (default its first checkout). */
const cliLocal = (box, args, cwd = box.first) => runCliInProcess(args, { cwd, env: box.env });

test('a non-browser check does not wait for the browser slot [C7]', async () => {
  const box = fixture();
  setBrowserFreeChecks(box, true);
  const { repo, base } = checkProject(box);
  const itemCheck = 'node apps/cli/src/io/run/tests.js --test-name-pattern "item check marker" test/cpu-check.test.js';
  const submitCheck = 'node apps/cli/src/io/run/tests.js --test-name-pattern "submit check marker" test/cpu-check.test.js';
  const classifyEnv = { ...process.env, NODE_OPTIONS: '' };
  assert.equal(await checkNeedsBrowser(repo, itemCheck, { env: classifyEnv }), false, 'an explicit CPU-only test file is classifiable');
  assert.equal(await checkNeedsBrowser(repo, 'node apps/cli/src/io/run/tests.js test/cockpit/brief.test.js', { env: classifyEnv }), true,
    'a named file with no readable declaration stays browser-gated');
  const added = await fixtureAdd((cwd, ...args) => cliLocal(box, args, cwd), repo, 'coordinator', 'CPU check item', '--check', itemCheck, '--route', 'strong', '--wait', '--json');
  assert.equal(added.status, 0, `${added.stdout}\n${added.stderr}`);
  const item = JSON.parse(added.stdout).item.item_id;
  assert.equal(existsSync(join(repo, 'item-check-started')), false, 'the setup baseline ran in its private clone');

  const browserHolder = poolWorker(box, { agent: 'check-browser-holder', browser: true, item: '636', kind: 'gate' });
  await acquired(browserHolder);
  const itemMarker = join(repo, 'item-check-started');
  const itemStarted = waitForMarker(itemMarker);
  // Process-level: a queued check waits on the gate lease beside other live pool processes, so it keeps its own process.
  const itemRun = runFixtureChildAsync(process.execPath, [BIN, 'check', String(item), '--yes'], { cwd: repo, env: box.env });
  const itemResult = await awaitNestedPhase(itemRun, async () => {
    try {
      await itemStarted;
      assert.ok(privateList(box).find(({ name }) => name === 'browser')?.holders.some(({ agent }) => agent === 'check-browser-holder'),
        'the item check starts while the unrelated browser lease remains held');
    } finally { await release(browserHolder); }
  });
  assert.equal(itemResult.status, 0, itemResult.failure ?? itemResult.stderr);
  assert.equal(readFileSync(itemMarker, 'utf8'), 'started');

  const nextBrowserHolder = poolWorker(box, { agent: 'submit-browser-holder', browser: true, item: '636', kind: 'gate' });
  await acquired(nextBrowserHolder);
  const submitMarker = join(repo, 'submit-check-started');
  const submitStarted = waitForMarker(submitMarker);
  // Process-level: the submit check is an ES-module script that waits on the lease in its own process.
  const submitRun = runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', SUBMIT_CHECK, repo, base, submitCheck], { cwd: repo, env: box.env });
  let submitStartFailure = null;
  const submitResult = await awaitNestedPhase(submitRun, async () => {
    try {
      try { await submitStarted; }
      catch (error) { submitStartFailure = error; }
      assert.ok(privateList(box).find(({ name }) => name === 'browser')?.holders.some(({ agent }) => agent === 'submit-browser-holder'),
        'the submission check starts while the unrelated browser lease remains held');
    } finally { await release(nextBrowserHolder); }
  });
  assert.equal(submitStartFailure, null, `${submitStartFailure?.message ?? ''}\n${submitResult.stdout}\n${submitResult.stderr}`);
  assert.equal(submitResult.status, 0, submitResult.failure ?? submitResult.stderr);
  assert.deepEqual(JSON.parse(submitResult.stdout), {
    green: true, full: false, reason: '', files: ['test/cpu-check.test.js'], checkGreen: true,
  }, submitResult.stderr);
});

test('browser-free checks skip the slot only when the machine allows it [C7]', async () => {
  const box = fixture();
  const { repo } = checkProject(box);
  const check = `out=$(node apps/cli/src/io/run/tests.js --test-name-pattern "item check marker" test/cpu-check.test.js 2>&1); printf '%s\\n' "$out"; printf '%s\\n' "$out" | grep -Eq '^[[:space:]]*ok [0-9]+ - item check marker' && printf '%s\\n' "$out" | grep -Eq '^# fail 0$'`;
  const added = await fixtureAdd((cwd, ...args) => cliLocal(box, args, cwd), repo, 'coordinator', 'Browser-free policy check', '--check', check, '--route', 'strong', '--wait', '--json');
  assert.equal(added.status, 0, `${added.stdout}\n${added.stderr}`);
  const item = JSON.parse(added.stdout).item.item_id;
  const marker = join(repo, 'item-check-started');

  async function checkWithPolicy(value, shouldStartWithBrowserHeld) {
    setBrowserFreeChecks(box, value);
    rmSync(marker, { force: true });
    const browserHolder = poolWorker(box, { agent: `policy-browser-${String(value)}`, browser: true, item: '681', kind: 'gate' });
    await acquired(browserHolder);
    const started = waitForMarker(marker);
    const startedOutcome = started.then(() => null, error => error);
    // Process-level: the queued check must wait in the gate line while this process polls the pool.
    const resultPromise = runFixtureChildAsync(process.execPath, [BIN, 'check', String(item), '--yes'], { cwd: repo, env: box.env });
    const result = await awaitNestedPhase(resultPromise, async () => {
      try {
        if (shouldStartWithBrowserHeld) {
          await started;
          assert.ok(privateList(box).find(({ name }) => name === 'browser')?.holders.some(({ agent }) => agent === `policy-browser-${String(value)}`),
            'the browser lease stays live while an opted-in browser-free check runs');
        } else {
          await waitUntil(() => privateList(box).find(({ name }) => name === 'gate')?.line.some(({ kind, item: waitingItem }) => kind === 'check' && waitingItem === String(item)),
            'a browser-disabled check to wait in the gate queue');
          assert.equal(existsSync(marker), false, 'the check does not start while browser-free checks are disabled or absent');
        }
      } finally { await release(browserHolder); }
    });
    assert.equal(result.status, 0, result.failure ?? result.stderr);
    assert.equal(await startedOutcome, null, 'the check marker observer settles and closes');
    assert.equal(readFileSync(marker, 'utf8'), 'started');
  }

  await checkWithPolicy(false, false);
  await checkWithPolicy(true, true);
  await checkWithPolicy(undefined, false);
});
