/** Real conflict returns and read-only correction of legacy conflict notes [C7,B3,D1]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { eventCauses } from '../../../../packages/store/index.js';
import { REOPEN_CAUSE_ENGINE } from '../../../../packages/state/light.js';
import {
  exportBoard,
  importBoard,
} from '../../../../packages/store/index.js';
import {
  ensureRigorCounters,
  resumeRigorCounters,
  RIGOR_COLD_NOTICE,
} from '../../../../packages/rigor/index.js';
import { conflictReport } from '../../../../packages/rigor/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { trunkMerge } from '../../../../packages/merge/index.js';
import { causeKit } from '../../tests/fixtures/reopen/cause.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);
const { FILE, SECOND, json, project, submit, accept, conflict, latest, assertConflict } = causeKit(helpers, { trunkMerge });

test('manual landing conflict notes are verified by Git and recorded as conflicts [C7,B3]', async () => {
  const box = project();
  const entry = (await submit(box));
  (await accept(box, entry));
  const merge = conflict(box, entry);
  const note = `${FILE}: does not merge onto the trunk (conflicts: ${merge.files.join(' ')}), reopened for the builder merge; merge commit ${merge.commit}`;
  (await json(box, box.repo, 'reopen', String(entry.id), '--note', note));
  assertConflict(latest(box, entry.id), merge.files);
});

test('a legacy-shaped conflict note cannot reopen clean Git work [C7,B3]', async () => {
  const box = project();
  const entry = (await submit(box));
  (await accept(box, entry));
  const trunk = box.git(box.repo, 'rev-parse', 'main');
  const note = `${FILE}: does not merge onto the trunk (conflicts: ${FILE}), reopened for the builder merge; merge commit ${trunk}`;
  const refused = (await box.runLocal(box.repo, 'reopen', String(entry.id), '--note', note, '--json'));
  assert.equal(refused.code, 1);
  assert.equal(JSON.parse(refused.out).error.code, 'NOT_CONFLICTING');
  // @pullboard-board-file journey: verify the refused CLI reopen left its actual accepted item and durable event history unchanged
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    assert.equal(store.getItem(board, entry.id).item_status, 'verified');
    assert.equal(store.events(board, { itemId: entry.id }).filter(row => row.event_kind === 'reopen').length, 0);
  } finally { store.closeBoard(board); }
});

test('legacy notes preserve ordinary state refusals before a submitted commit exists [C7,B3]', async () => {
  const box = project();
  const added = (await json(box, box.repo, 'add', 'web', 'Still being built', '--specs', 'G1',
    '--criterion', 'Both modules remain valid.', '--check', 'node --check ' + FILE, '--accept-green', 'fixture check keeps passing'));
  const id = added.item.item_id;
  const trunk = box.git(box.repo, 'rev-parse', 'main');
  const note = `${FILE}: does not merge onto the trunk (conflicts: ${FILE}), reopened for the builder merge; merge commit ${trunk}`;
  for (const claimed of [false, true]) {
    if (claimed) (await json(box, box.web, 'claim', String(id)));
    const refused = (await box.runLocal(box.repo, 'reopen', String(id), '--note', note, '--json'));
    assert.equal(refused.code, 1);
    assert.equal(JSON.parse(refused.out).error.code, 'NOT_SUBMITTED');
    // @pullboard-board-file journey: read the CLI fixture's current claim state and prove refusal appended no reopen event
    const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
    try {
      assert.equal(store.getItem(board, id).item_status, claimed ? 'claimed' : 'open');
      assert.equal(store.events(board, { itemId: id }).filter(row => row.event_kind === 'reopen').length, 0);
    } finally { store.closeBoard(board); }
  }
});

test('a confirmed conflict overrides an unrelated explicit test cause [C7,B3,D1]', async () => {
  const box = project();
  const entry = (await submit(box));
  (await accept(box, entry));
  const merge = conflict(box, entry);
  // @pullboard-board-file journey: export the native CLI submission and verify replay never changes that durable source board
  const source = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  const older = openBoard(':memory:');
  try {
    importBoard(older, exportBoard(source));
    older.executionEngineVersion = REOPEN_CAUSE_ENGINE - 1;
    store.reopen(older, entry.id, { agentId: 'coordinator', conflict: { files: merge.files, trunk: merge.commit },
      cause: 'test:web/unrelated.test.js::unrelated test' });
    const oldDetail = JSON.parse(store.events(older, { itemId: entry.id }).findLast(row => row.event_kind === 'reopen').event_detail);
    assert.equal(oldDetail.cause, 'test:web/unrelated.test.js::unrelated test', 'prior-engine replay retains its original recorded meaning');
    assert.equal(oldDetail.causeDerivation, undefined);
    assert.equal(store.getItem(source, entry.id).item_status, 'verified', 'the replay control never changes the native board');
  } finally { store.closeBoard(older); store.closeBoard(source); }
  (await json(box, box.repo, 'reopen', String(entry.id), '--conflict', merge.files[0],
    '--cause', 'test:web/unrelated.test.js::unrelated test'));
  assertConflict(latest(box, entry.id), merge.files);
});

test('review selection records the actual submitted-head conflict files [C7,B3]', async () => {
  const box = project();
  const entry = (await submit(box));
  const merge = conflict(box, entry);
  const reviewer = join(box.dir, 'reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, 'main');
  (await json(box, reviewer, 'join', 'api'));
  (await box.runLocal(reviewer, 'next', '--verify', '--json'));
  assertConflict(latest(box, entry.id), merge.files);
});

test('historical conflict-note correction is explicit and leaves original event bytes untouched [C7,D1]', () => {
  const box = project();
  const board = openBoard(':memory:');
  try {
    const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Legacy correction', specs: 'G1', criterion: 'Retain original evidence.', check: 'true' });
    const trunk = box.git(box.repo, 'rev-parse', 'main');
    const name = `does not merge onto the trunk (conflicts: ${FILE} ${SECOND}), reopened for the builder merge`;
    const note = `${FILE}: ${name}; merge commit ${trunk}`;
    store.logEvent(board, 'coordinator', 'reopen', id, { commit: 'a'.repeat(40), note, judgment: null,
      cause: `test:${FILE}::${name}`, landingFailure: { batch: null, tests: [{ file: FILE, name }], mergeCommit: trunk } });
    const original = board.db.prepare("SELECT * FROM event WHERE item_id=? AND event_kind='reopen'").get(id);
    assert.deepEqual(eventCauses(original).sort(), [FILE, SECOND].map(file => 'conflict:' + encodeURI(file)).sort());
    const report = conflictReport(store.events(board), { now: board.clock.now() });
    assert.deepEqual(report.conflictFiles.map(row => row.file).sort(), [FILE, SECOND].sort());
    assert.ok(report.conflictFiles.every(row => row.events[0].source === 'legacy-conflict-note'), 'inferred note history never claims Git attestation');
    assert.deepEqual(board.db.prepare('SELECT * FROM event WHERE event_id=?').get(original.event_id), original, 'read correction never rewrites immutable history');
    assert.equal(store.getItem(board, id).item_status, 'open', 'a historical correction creates no acceptance or workflow authority');
    const thread = store.itemThread(board, id).find(row => row.eventId === original.event_id);
    assert.equal(thread.detail.cause, JSON.parse(original.event_detail).cause, 'the original cause remains inspectable');
    assert.equal(thread.causeCorrection.source, 'legacy-conflict-note');
    assert.deepEqual(thread.causeCorrection.causeDerivation.files, [FILE, SECOND]);
    ensureRigorCounters(board);
    const key = 'local:proof-stats:rigor:v1:summary';
    const summary = JSON.parse(board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(key).meta_value);
    summary.data.version = 1;
    board.db.prepare('UPDATE board_meta SET meta_value=? WHERE meta_key=?').run(JSON.stringify(summary), key);
    assert.equal(resumeRigorCounters(board, {}).notice, RIGOR_COLD_NOTICE, 'the pre-correction summary cannot pretend to be current');
    assert.deepEqual(resumeRigorCounters(board, {}).causes, []);
    ensureRigorCounters(board);
    assert.equal(resumeRigorCounters(board, {}).notice, null);
    assert.deepEqual(resumeRigorCounters(board, {}).causes, []);
    assert.deepEqual(board.db.prepare('SELECT * FROM event WHERE event_id=?').get(original.event_id), original);
  } finally { store.closeBoard(board); }
});
