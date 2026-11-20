/** @pullboard-test-input source-cell apps/cli */
/** Submit runs the coordinator's frozen check itself, so a builder who never ran pullboard check still submits [C7,#11844]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  builderRepo,
  commitAll,
  privateRepo,
  put,
} from '../../tests/fixtures/submit/gate.js';
import {
  coordinatorLocal,
  runLocal,
} from '../../tests/fixtures/submit/local.js';

test('cli.journeys-submit-frozen-check.submits-without-pullboard-check: clause 3: an item whose coordinator check is unticked is submitted without the builder running pullboard check [C7,#11844]', { timeout: 240_000 }, async (t) => {
  let box = privateRepo(t);
  put(box.root, 'pullboard.json', JSON.stringify({ gate: 'true', shared: ['pullboard.json'], verify: { inspectClauses: true } }));
  box = builderRepo(box);
  const added = await coordinatorLocal(box, 'add', 'build', 'Frozen check at submit', '--check', 'test -e test/frozen.test.js && node --test test/frozen.test.js',
    '--criterion', '1. The fixture count test passes [test].');
  assert.equal(added.code, 0, added.err + added.out);
  const claimed = await runLocal(box, 'claim', '1');
  assert.equal(claimed.code, 0, claimed.err + claimed.out);
  put(box.root, 'test/frozen.test.js', "import { test } from 'node:test';\ntest('clause 1: the fixture count passes', () => {});\n");
  commitAll(box, 'test(core): a passing fixture test [G1]');
  const submitted = await runLocal(box, 'submit', '1');
  const answer = submitted.err + submitted.out;
  assert.equal(submitted.code, 0, answer);
  assert.match(answer, /submit runs the frozen check of #1: test -e test\/frozen\.test\.js && node --test test\/frozen\.test\.js/u);
  assert.doesNotMatch(answer, /CLAUSE_UNTICKED|CHECK_CONFIRM/u);
});
