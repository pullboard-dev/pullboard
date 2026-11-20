/** @pullboard-test-input apps/runner/index.js packages/gate/src/io/browser/guard.js */
/** Output digest cases split from checks-output.test.js (V18, V2). */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { checkAtCommit } from '../../../runner/index.js';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { privateCheckSubmission } = e2e;

test('cli.journeys-verify-checks-output-digest.accept-reports-failed-install-as-check: accept reports failed install as CHECK_UNVERIFIED with an output digest [V18,V2]', async () => {
  const box = privateCheckSubmission({ install: 'echo install-failed; exit 9', check: 'true' });
  const refused = await box.runLocal(box.review, 'verify', '1', 'accept', '--note', 'install must complete before verification', '--json');
  assert.equal(refused.code, 1);
  const error = JSON.parse(refused.out).error;
  assert.equal(error.code, 'CHECK_UNVERIFIED');
  assert.match(error.message, /install failed/);
  assert.match(error.message, /output digest/);
  assert.match(error.message, /install-failed/);
  assert.match(error.next, /^restore the install or check environment, then retry verification/);
});

test('cli.journeys-verify-checks-output-digest.private-check-digest-keeps-install-and: private check digest keeps install and noisy check output in separate sections [V18,V2]', () => {
  const box = privateCheckSubmission({
    install: 'echo install-marker',
    check: 'i=0; while [ "$i" -lt 200 ]; do echo noisy-check-output-$i; i=$((i + 1)); done; echo check-failed; exit 1',
  });
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test reads that same file.
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  let item;
  try { item = store.getItem(board, 1); }
  finally { store.closeBoard(board); }
  const proof = checkAtCommit(box.repo, item);
  assert.equal(proof.state, 'red');
  assert.match(proof.report, /install output:\ninstall-marker/);
  assert.match(proof.report, /check output:[\s\S]*check-failed/);
});
