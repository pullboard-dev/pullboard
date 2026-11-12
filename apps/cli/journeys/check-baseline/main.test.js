/** Check baselines run on add and edit in the background and refuse a manual run [V2,B35,H16]. */
import assert from 'node:assert/strict';
import { startFixtureChild } from '../../tests/fixtures/child.js';
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { getItem } from '../../../../packages/store/index.js';
import { jobsOf } from '../../../../packages/jobs/index.js';
import { fixtureAddArgv } from '../../tests/fixtures/testkit.js';
import { HOST } from '../../tests/fixtures/runner/ssh.js';
import {
  BIN,
  BOARD_FILE,
  project,
  fileCheck,
  addChecked,
  showItem,
  waitForState,
  heldCheck,
  cleanupFixtures,
  withBoard,
} from '../../tests/fixtures/check-baseline.js';

after(cleanupFixtures);

test('[B35,V2,H16] #2370 add records a pending isolated baseline and runs it in background', async (t) => {
  const box = project({ content: 'committed' });
  const originalMain = box.git(box.repo, 'rev-parse', 'main');
  writeFileSync(join(box.repo, 'web/result.txt'), 'dirty live checkout\n');
  const observations = join(box.dir, 'add-baseline-locations');
  const command = fileCheck('committed', 'add-baseline-marker', observations);
  const edit = heldCheck(box, 'edit-background');
  t.after(() => writeFileSync(edit.release, 'release'));
  // Process-level: add and edit start the baseline in a detached CLI worker, which an in-process call cannot launch.
  const added = box.run(box.repo, ['add', 'web', 'Automatic baseline', '--check', command, '--json']);
  assert.equal(added.status, 0, `${added.stdout}${added.stderr}`);
  const item = JSON.parse(added.stdout).item;
  assert.equal(item.item_check_baseline.result, 'pending');
  assert.equal(item.item_check_baseline.main, originalMain);
  await waitForState(() => withBoard(join(box.repo, BOARD_FILE), (board) => getItem(board, item.item_id).item_check_baseline?.result === 'green'), 'the detached add worker records its result');
  const locations = readFileSync(observations, 'utf8').trim().split('\n');
  assert.equal(locations.length, 1, 'add runs exactly one baseline');
  assert.notEqual(locations[0], box.repo);
  assert.ok(locations[0].startsWith(box.worker), `the baseline ran in the registered runner's checkout: ${locations[0]}`);
  assert.equal(existsSync(locations[0]), false, 'the isolated checkout is removed after the baseline completes');
  assert.match((await box.runLocal(box.repo, ['show', String(item.item_id)])).stdout, /CRITERION_PROVES_NOTHING/u);
  const edited = box.run(box.repo, ['edit', String(item.item_id), '--check', edit.command, '--json']);
  assert.equal(edited.status, 0, `${edited.stdout}${edited.stderr}`);
  assert.equal(existsSync(edit.finished), false, 'edit returns before its changed check finishes');
  assert.equal(JSON.parse(edited.stdout).item.item_check_baseline.result, 'pending');
  await waitForState(() => existsSync(edit.started), 'the detached edit worker starts');
  writeFileSync(edit.release, 'release');
  await waitForState(() => withBoard(join(box.repo, BOARD_FILE), (board) => getItem(board, item.item_id).item_check_baseline?.result === 'green'), 'the background edit result is recorded');
  const final = showItem(box, item.item_id).item;
  assert.equal(final.item_check_baseline.command, edit.command);
  assert.equal(final.item_check_baseline.warning, 'CRITERION_PROVES_NOTHING');
  assert.equal(readFileSync(join(box.repo, 'web/result.txt'), 'utf8'), 'dirty live checkout\n');
});

test('[B35,V2,H16] #2370 default add returns before a held baseline completes', async (t) => {
  const box = project({ content: 'committed' });
  const held = heldCheck(box, 'add-default-held');
  t.after(() => writeFileSync(held.release, 'release'));
  const added = box.run(box.repo, ['add', 'web', 'Background held check', '--check', held.command, '--json'], undefined, { timeout: 8000 });
  assert.equal(added.status, 0, `${added.stdout}${added.stderr}`);
  assert.equal(JSON.parse(added.stdout).item.item_check_baseline.result, 'pending');
  await waitForState(() => existsSync(held.started), 'the background baseline starts');
  assert.equal(existsSync(held.finished), false, 'add returned before the held baseline finished');
  writeFileSync(held.release, 'release');
});

// Process-level: the waited add runs as a real concurrent child while the probe verify contends for the checkout.
test('[B35,V2,H16] #2370 waited add releases checkout while its baseline runs', async (t) => {
  const box = project({ content: 'committed' });
  const held = heldCheck(box, 'add-checkout-release');
  box.env.CODEX_THREAD_ID = 'baseline-add-wait-fixture';
  const child = startFixtureChild(process.execPath, [...fixtureAddArgv(BIN), 'web', 'Wait without checkout lock', '--check', held.command, '--wait', '--json'],
    { cwd: box.repo, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk; });
  const done = new Promise(resolve => child.once('close', (status, signal) => resolve({ status, signal })));
  t.after(() => { writeFileSync(held.release, 'release'); if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
  await waitForState(() => existsSync(held.started), 'the add baseline starts');
  assert.equal(existsSync(held.finished), false, 'the add still waits for the held baseline');
  const probe = await box.runLocal(box.repo, ['verify', '999999', 'accept', '--note', 'checkout lock probe', '--as', 'coordinator', '--json']);
  assert.notEqual(probe.status, null, `verify must acquire checkout while the baseline waits: ${probe.stderr}`);
  assert.equal(JSON.parse(probe.stdout).error.code, 'NO_ITEM');
  assert.equal(existsSync(held.finished), false, 'verify completed before the baseline was released');
  writeFileSync(held.release, 'release');
  const result = await done;
  assert.equal(result.status, 0, `waited add failed: ${stdout}`);
  assert.equal(JSON.parse(stdout).item.item_check_baseline.result, 'green');
});

test('[B35,V2] #2370 waited add records a red baseline and flags an already-green check', () => {
  const box = project({ content: 'before' });
  const red = addChecked(box, 'Red baseline', fileCheck('after'));
  assert.equal(red.item.item_check_baseline.result, 'red');
  assert.equal(red.item.item_check_baseline.main, box.git(box.repo, 'rev-parse', 'main'));
  const green = box.run(box.repo, ['add', 'web', 'Already green', '--check', fileCheck('before'), '--wait']);
  assert.equal(green.status, 0, `${green.stdout}${green.stderr}`);
  assert.match(green.stdout, /warning: \[CRITERION_PROVES_NOTHING\]/u);
});

test('[B35,V2] manual check-baseline is refused because creation owns the observation', async () => {
  const box = project();
  const refused = await box.runLocal(box.repo, ['check-baseline', '1']);
  assert.notEqual(refused.status, 0);
  assert.match(`${refused.stdout}${refused.stderr}`, /CHECK_BASELINE_AUTOMATIC.*the board baselines checks on add/u);
});

test('[B35,V2,C7] #6560 with no registered runner the baseline is a pulled job on the local runner, never run inline on the host', { timeout: 150_000 }, async (t) => {
  const box = project({ content: 'committed' });
  // A real local runner process pulls the job over loopback; no push runner is registered, so it is the only place the check can run.
  assert.equal((await box.runLocal(box.repo, ['runner', 'remove', HOST, '--json'])).status, 0, 'the fixture runner is removed');
  const observations = join(box.dir, 'pulled-baseline-locations');
  t.after(() => box.runLocal(box.repo, ['runner', 'local', '--off']));
  const added = await box.runLocal(box.repo, ['add', 'web', 'Pulled baseline', '--check', fileCheck('committed', 'pulled-marker', observations), '--wait', '--json']);
  assert.equal(added.status, 0, `${added.stdout}${added.stderr}`);
  const item = JSON.parse(added.stdout).item;
  assert.equal(withBoard(join(box.repo, BOARD_FILE), (board) => getItem(board, item.item_id).item_check_baseline.result), 'green', 'the local runner recorded the baseline within the wait');
  const jobs = withBoard(join(box.repo, BOARD_FILE), (board) => jobsOf(board.db, { kind: 'check-baseline', item: item.item_id }));
  assert.equal(jobs.length, 1, 'one pulled check-baseline job was offered');
  assert.match(jobs[0].leaseOwner ?? jobs[0].steps.find((step) => step.name === 'receipt')?.payload.runner ?? '', /^local-/u, 'the local runner took it');
  const where = readFileSync(observations, 'utf8').trim().split('\n');
  assert.equal(where.length, 1);
  assert.notEqual(where[0], box.repo, 'the check never ran in the host checkout');
  assert.equal(existsSync(join(box.repo, 'pulled-marker')), false, 'the host wrote no check output');
  assert.match((await box.runLocal(box.repo, ['show', String(item.item_id)])).stdout, /CRITERION_PROVES_NOTHING/u);
});
