/** A green baseline holds its item only when the test file the check names exists on main [C7,#11825]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureGit } from '../../../fixtures/child.js';
import { fixtureProjectPolicy } from '../../../fixtures/testkit.js';
import { temporaryRepository } from '../../../../../store/tests/fixtures/submit.js';
import { openKitBoard } from '../../../../../board/tests/fixtures/board.js';
import { addItem } from '../../../../../store/index.js';
import { closeBoard } from '../../../../../store/index.js';
import { getItem } from '../../../../../store/index.js';
import { recordPulledBaseline } from '../../../../src/io/check/baseline/worker.js';

const GIT = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'core.hooksPath=/dev/null'];

/** A repository whose main asks for the hold and carries one existing test file; returns its root and main commit. */
function holdingRepository(t) {
  const repo = temporaryRepository(t, 'pullboard-baseline-worker-');
  fixtureProjectPolicy(repo, { config: { checks: { provesNothing: 'hold' } } });
  mkdirSync(join(repo, 'test'));
  writeFileSync(join(repo, 'test/old.test.js'), "import { test } from 'node:test';\ntest('old', () => {});\n");
  runFixtureGit([...GIT, 'add', '-A'], { cwd: repo });
  runFixtureGit([...GIT, 'commit', '-q', '-m', 'fixture: policy and one test'], { cwd: repo });
  return { repo, main: runFixtureGit(['rev-parse', 'HEAD'], { cwd: repo }) };
}

/** Record a green pulled baseline for an item whose check is `command`, on a real board bound to the scratch repository. */
function recordGreen(t, { repo, main }, command, n) {
  const board = openKitBoard(':memory:', undefined, { gitRoot: repo });
  t.after(() => closeBoard(board));
  const request = `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
  const id = addItem(board, { by: 'coordinator', lane: 'web', title: `Baseline ${n}`, check: command,
    checkBaseline: { command, main, result: 'pending', request } });
  const recorded = recordPulledBaseline(board, { item: id, expected: { command, main, request }, run: { exitCode: 0, output: '' }, seconds: 1 });
  assert.equal(recorded, true, 'the pulled baseline was recorded');
  const item = getItem(board, id);
  assert.equal(item.item_check_baseline.result, 'green');
  return item;
}

test('gate.io-check-baseline-worker.new-file-expected-red: clause 1: a green check baseline whose check names a test file absent from main is recorded without a hold [C7,#11825]', t => {
  const item = recordGreen(t, holdingRepository(t), 'node packages/gate/src/io/run/tests.js test/new.test.js', 1);
  assert.equal(item.item_hold_reason ?? null, null);
});

test('gate.io-check-baseline-worker.existing-file-held: clause 2: a green baseline whose named test file exists on main, or whose check names no test file, still holds the item [C7,#11825]', t => {
  const box = holdingRepository(t);
  const named = recordGreen(t, box, 'node packages/gate/src/io/run/tests.js test/old.test.js', 2);
  assert.ok(named.item_hold_reason, 'an existing named file holds');
  const none = recordGreen(t, box, 'node -e "process.exit(0)"', 3);
  assert.ok(none.item_hold_reason, 'a check naming no test file holds');
});

test('gate.io-check-baseline-worker.real-pull: clause 3: recordPulledBaseline decides the hold through the one helper, on a real board and a scratch git repository [C7,#11825]', t => {
  const box = holdingRepository(t);
  assert.equal(recordGreen(t, box, 'node packages/gate/src/io/run/tests.js test/other.test.mjs', 4).item_hold_reason ?? null, null);
  assert.ok(recordGreen(t, box, 'node packages/gate/src/io/run/tests.js ./test/old.test.js', 5).item_hold_reason);
});
