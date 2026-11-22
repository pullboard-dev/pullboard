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
