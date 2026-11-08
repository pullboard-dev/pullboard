/** @pullboard-test-loads packages/store/index.js */
/** pullboard land --waive while the board owns landing lifts a trunk test-defect hold [#3675]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import * as store from '../packages/store/index.js';
import { heldTestDefects } from '../packages/landing/src/shell/landing-step-selection.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { fixtureOpenBoard } from './testkit-fixture.js';
import { landingPorts } from './landing-ports-fixture.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

const HELD = 'web/held.test.js';

/** Run a board command and parse its JSON document. */
function command(box, ...args) {
  const ran = box.run(box.repo, ...args, '--json');
  let document;
  try { document = JSON.parse(ran.out); } catch { document = null; }
  return { ...ran, document };
}

/** A project whose accepted policy lets the board own landing, holding a committed test defect on its trunk. */
function heldProject() {
  const box = helpers.project();
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, HELD), "import { test } from 'node:test';\ntest('held [E27]', () => {});\n");
  const file = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  delete config.landing.manualOverride;
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: the board owns landing and a held test is committed');
  return box;
}

/** Read the held defects the real landing step computes for the current trunk. */
function held(box) {
  const board = fixtureOpenBoard({ boardFile: join(box.repo, '.git/pullboard/board.sqlite'), web: box.repo });
  try {
    return heldTestDefects(box.repo, board, { branch: 'refs/heads/main', commit: box.git(box.repo, 'rev-parse', 'HEAD') }, landingPorts);
  } finally { store.closeBoard(board); }
}

/** File the defect the automatic lander would file for the held test. */
function fileDefect(box) {
  const board = fixtureOpenBoard({ boardFile: join(box.repo, '.git/pullboard/board.sqlite'), web: box.repo });
  try {
    store.recordLandingTestDefect(board, { agentId: 'coordinator', test: HELD,
      hash: createHash('sha256').update(readFileSync(join(box.repo, HELD))).digest('hex'),
      blob: box.git(box.repo, 'rev-parse', `HEAD:${HELD}`), trunkBlob: null, names: ['held [E27]'], lane: 'web',
      batchId: '11111111-1111-4111-8111-111111111111', branch: 'refs/heads/main' });
  } finally { store.closeBoard(board); }
}

test('clause 1: land --waive records the signed person waiver while the board owns landing, and plain land still refuses BOARD_LANDS_ACCEPTED [C7]', () => {
  const box = heldProject();
  const plain = command(box, 'land');
  assert.equal(plain.document?.error?.code, 'BOARD_LANDS_ACCEPTED', plain.out + plain.err);
  const waived = command(box, 'land', '--waive', HELD, '--until', '2099-01-01', '--reason', 'Fixture hold is repaired on trunk.');
  assert.equal(waived.code, 0, waived.out + waived.err);
  assert.equal(waived.document.waiver.test, HELD);
  assert.equal(waived.document.waiver.by, 'person');
  assert.equal(command(box, 'land').document?.error?.code, 'BOARD_LANDS_ACCEPTED', 'a waiver does not open plain landing');
});

test('clause 2: after the waiver the held defect no longer holds the trunk in the landing step [C7]', () => {
  const box = heldProject();
  fileDefect(box);
  assert.deepEqual(held(box).map(defect => defect.test), [HELD], 'the unwaived defect holds the trunk');
  const waived = command(box, 'land', '--waive', HELD, '--until', '2099-01-01', '--reason', 'Fixture hold is repaired on trunk.');
  assert.equal(waived.code, 0, waived.out + waived.err);
  assert.deepEqual(held(box), [], 'the live person waiver covers every failing name');
});
