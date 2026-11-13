/** A case already red on main never fails the item's gate; a newly red case still does [C7,V4,B3]. */
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  cli,
  fixture,
  rows,
} from '../../tests/fixtures/affected.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { settleSubmit } from '../../tests/fixtures/submit/settle.js';

/** Two cases red on main; the item changes neither. */
const SHARED = "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\n"
  + "test('alpha case [G1]', () => assert.equal(1, 2));\ntest('beta case [G1]', () => assert.equal(1, 3));\n";
const CHECK = 'node test/runner.js test/affected.test.js';

/** File an open repair for the shared file whose criterion names one case, or none. */
function repair(box, criterion) {
  const args = ['add', 'core', `Main red: ${criterion}`, '--specs', 'G1', '--criterion', criterion,
    '--check', CHECK, '--brief', 'Files: test/affected.test.js\nTest: shared cases'];
  let result = cli(box, box.root, ...args);
  // The second repair reads like the first by design: answer the near-duplicate guard with the nearest id it names.
  const nearest = /DUPLICATE_LIKELY[\s\S]*?#(\d+)/u.exec(result.stdout + result.stderr)?.[1];
  if (result.status !== 0 && nearest) result = cli(box, box.root, ...args, '--not-duplicate-of', `${nearest} each repair owns a different case`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout).item.item_id;
}

test('a check case red on main with two candidate repairs is reported as known-main and the gate passes [C7,V4,B3]', async t => {
  const box = fixture(t, { affected: SHARED, check: CHECK });
  const alpha = repair(box, "The case 'alpha case' passes on main.");
  const shared = repair(box, 'The shared file passes on main.');
  const run = async (cwd, ...args) => {
    const shown = await runCliInProcess(args, { cwd, env: box.env });
    return { code: shown.status, out: shown.stdout ?? '', err: shown.stderr ?? '' };
  };
  const submitted = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(submitted.status, 0, submitted.stdout + submitted.stderr);
  // The pulled gate submits once main's receipt for the file records; its proof names the ambiguous case (#7373).
  let shown = null;
  const until = doc => { shown = doc; return doc?.item_status === 'submitted'; };
  await settleSubmit(t, { repo: box.builder, env: box.env, run }, JSON.parse(submitted.stdout), { until, deadlineMs: 75_000 })
    .catch(error => { throw new Error(`${error.message.split('\n')[0]}; thread: ${JSON.stringify((shown?.thread ?? []).slice(-4)).slice(0, 2000)}`); });
  const events = rows(box, "SELECT event_detail FROM event WHERE item_id=? AND event_kind='submit'", box.item);
  assert.equal(events.length, 1);
  const proof = JSON.parse(events[0].event_detail).submissionProof;
  assert.deepEqual(proof.knownMainAmbiguous, [{ file: 'test/affected.test.js', name: 'beta case [G1]', candidates: [alpha, shared] }]);
  assert.deepEqual(proof.knownMainFailures.failures.map(row => [row.name, row.item]), [['alpha case [G1]', alpha]], 'the uniquely owned case keeps its repair link');
  assert.ok(JSON.stringify(shown.thread).includes(`(beta case [G1]): several candidate repairs #${alpha}, #${shared}`), JSON.stringify(shown.thread.slice(-4)));
});

test('a case newly red on the item still fails the gate even beside known-main reds [C7,V4,B3]', { skip: 'PULL_GAP: un-skipped by #7372' }, t => {
  const box = fixture(t, { affected: SHARED, check: CHECK });
  repair(box, "The case 'alpha case' passes on main.");
  repair(box, 'The shared file passes on main.');
  appendFileSync(join(box.builder, 'test/affected.test.js'), "test('gamma case [G1]', () => assert.equal(1, 4));\n");
  runFixtureGit(['commit', '-qam', 'test(core): a new red case [G1]'], { cwd: box.builder, env: box.env });
  const result = cli(box, box.builder, 'submit', String(box.item), '--no-next');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, 'GATE_RED');
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 0);
});
