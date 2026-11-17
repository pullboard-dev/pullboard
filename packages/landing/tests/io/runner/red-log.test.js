/** @pullboard-test-input source-cell packages/landing */
/** A red land job keeps the failing test names, a path to its full log, and the merged commit [C7,#8499]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture } from '../../fixtures/plan.js';
import { git } from '../../fixtures/plan.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runLandingJob } from '../../../index.js';

const ITEM = 52;
// A stand-in runner: the item's own file is a shell script printing a red TAP run, and the runner is `sh`.
const TAP = [
  'TAP version 13', 'not ok 1 - landing contracts hold', '  ---', "  location: 'packages/x/tests/a.test.js:3:1'", '  ...',
  'ok 2 - fine', 'not ok 3 - second case fails', '  ---', "  location: 'packages/x/tests/b.test.js:9:1'", '  ...',
  '# fail 2', 'EARLY-LINE-ONLY-IN-THE-FULL-LOG'].map(line => `echo '${line}'`).concat('exit 1').join('\n') + '\n';

/** A bare trunk holding main and one item commit whose file is the red runner script; returns the red job's receipt and log folder. */
async function redJob(t) {
  const { root: dir } = privateFixtureFiles('pullboard-land-red-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { root: work, put } = fixture(t);
  const remote = join(dir, 'remote.git');
  git(dir, 'clone', '-q', '--bare', work, remote);
  git(work, 'checkout', '-q', '-b', 'item');
  put('red.sh', TAP);
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'feat: item [C7]');
  const commit = git(work, 'rev-parse', 'HEAD').trim();
  git(work, 'push', '-q', remote, 'main:refs/heads/main', `item:refs/heads/item-${ITEM}`);
  const expect = git(dir, '--git-dir', remote, 'rev-parse', 'refs/heads/main').trim();
  const payload = { remote, trunk: 'refs/heads/main', expect, publish: 'separate', items: [{ id: ITEM, commit, ref: `refs/heads/item-${ITEM}` }], proof: { runner: 'sh', files: ['red.sh'] } };
  const logs = join(dir, 'logs');
  const workdir = join(dir, 'runner');
  const receipt = await runLandingJob(payload, { workdir, env: { ...process.env, PULLBOARD_LAND_LOG_DIR: logs } });
  return { receipt, workdir };
}

test('clause 1: a red land job records each failing test file and case name on the item [C7,#8499]', async t => {
  const { receipt } = await redJob(t);
  assert.equal(receipt.outcome, 'red');
  const [returned] = receipt.returned;
  assert.equal(returned.id, ITEM);
  for (const word of ['packages/x/tests/a.test.js', 'packages/x/tests/b.test.js', 'landing contracts hold', 'second case fails']) assert.ok(returned.detail.includes(word), `the returned item's detail names ${word}`);
  assert.deepEqual(receipt.failed.files, ['packages/x/tests/a.test.js', 'packages/x/tests/b.test.js']);
  assert.equal(receipt.failed.cases.length, 2);
});

test('clause 2: a red land job records a readable path to its full log and keeps the merged commit [C7,#8499]', async t => {
  const { receipt, workdir } = await redJob(t);
  const { log, commit, refs } = receipt.failed;
  assert.ok(returnedHasLog(receipt, log), 'the detail names the log path');
  const text = readFileSync(log, 'utf8');
  assert.ok(text.includes('EARLY-LINE-ONLY-IN-THE-FULL-LOG') && text.includes('# fail 2'), 'the log holds the whole output');
  assert.equal(git(workdir, 'rev-parse', refs[0]).trim(), commit, 'the merged commit stays reachable under a ref');
});

/** Whether the first returned item's detail carries the log's path. */
function returnedHasLog(receipt, log) { return receipt.returned[0].detail.includes(log); }
