/** @pullboard-test-loads packages/store/src/io/builder/family.js packages/store/src/io/board/claim.js packages/store/src/io/board/submit.js */
/** Required-family builds admit derived families before claiming and never submit an unknown builder [C7,#3078]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { openBoard } from '../index.js';
import { closeBoard } from '../index.js';
import * as store from '../../../packages/store/index.js';
import { temporaryDirectory } from '../../cli/tests/fixtures/board.js';
import { repositoryBoardFile } from '../../cli/tests/fixtures/board/submit.js';
import { submitFixture } from '../../cli/tests/fixtures/board/submit.js';
import { BUILDER_FAMILY_REQUIRED_ENGINE } from '../../../packages/state/light.js';

const FIXTURE_MODEL = 'Fixture';

/** Use a real committed required-family policy and SQLite board, with an explicitly unknown builder session. */
function fixture(t) {
  const root = temporaryDirectory('pullboard-builder-family-');
  const file = repositoryBoardFile(root);
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ lanes: {}, verify: { family: 'require' } }));
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qam', 'required family'], { cwd: root });
  // @pullboard-board-file persistence: the real submit in this fixture repository reopens the board file
  const board = openBoard(file);
  t.after(() => { closeBoard(board); rmSync(root, { recursive: true, force: true }); });
  store.register(board, { id: 'coordinator', lane: 'coordinator', path: root, family: 'human', model: FIXTURE_MODEL });
  store.register(board, { id: 'core-1', lane: 'core', path: join(root, 'builder'), session: 'unknown-build', model: FIXTURE_MODEL });
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Family admission', criterion: 'The builder is reviewable.' });
  /** Supply the immutable family policy captured by the native claim. */
  const freeze = () => ({ text: JSON.stringify({ policy: { verify: { family: 'require' } } }), digest: 'required-family-fixture' });
  const claim = { agentId: 'core-1', lane: 'core', leaseMs: 3_600_000, familyPolicy: 'require', freeze };
  return { root, board, id, claim };
}

test('clause 1: required-family claim refuses an unknown builder before freezing; a session-derived family builds and submits [C7,#3078]', t => {
  const { root, board, id, claim } = fixture(t);
  assert.throws(() => store.claim(board, id, claim), error => error.code === 'UNDECLARED_BUILDER_FAMILY'
    && /join <lane> --family <vendor>/u.test(error.message));
  assert.equal(store.getItem(board, id).item_owner, null);
  assert.equal(store.getItem(board, id).item_frozen_digest, null);
  store.register(board, { id: 'core-2', lane: 'core', path: join(root, 'peer'), session: 'unknown-build', family: 'anthropic', model: FIXTURE_MODEL });
  store.claim(board, id, claim);
  submitFixture(board, id, { agentId: 'core-1', commit: 'a'.repeat(40), tree: 'b'.repeat(40) });
  assert.equal(store.getItem(board, id).item_builder_family, 'anthropic');
});

test('clause 2: historical unknown claims replay unchanged but a modern required-family submit cannot record NULL [C7,#3078]', t => {
  const { board, id, claim } = fixture(t);
  board.executionEngineVersion = BUILDER_FAMILY_REQUIRED_ENGINE - 1;
  store.claim(board, id, claim);
  delete board.executionEngineVersion;
  assert.throws(() => submitFixture(board, id, { agentId: 'core-1', commit: 'a'.repeat(40), tree: 'b'.repeat(40) }),
    { code: 'UNDECLARED_BUILDER_FAMILY' });
  assert.equal(store.getItem(board, id).item_status, 'claimed');
  assert.equal(store.getItem(board, id).item_built_by, null);
  assert.equal(store.getItem(board, id).item_builder_family, null);
});
