/** Real conflict returns and read-only correction of legacy conflict notes [C7,B3,D1]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
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
import { trunkMerge } from '../../../../packages/merge/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { joinFixtureSeat } from '../../tests/fixtures/testkit.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);
const FILE = 'web/shared.js';
const SECOND = 'web/other.js';

/** Assert a fixture command succeeded before using its structured receipt. */
async function json(box, path, ...args) {
  const result = (await box.runLocal(path, ...args, '--json'));
  assert.equal(result.code, 0, result.out + result.err);
  return JSON.parse(result.out);
}

/** Create a local-only real board and a shared Git base without changing the person's storage. */
function project(separate = true) {
  const box = helpers.project('true');
  const file = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, ...(separate ? { landing: { perItem: false, manualOverride: true, publish: 'separate' } } : {}) }));
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  for (const path of [FILE, SECOND]) writeFileSync(join(box.repo, path), 'export const value = "base";\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: establish conflict fixture base');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  if (!separate) {
    const remote = join(box.dir, 'private-origin.git');
    box.git(box.dir, 'init', '-q', '--bare', remote);
    box.git(box.repo, 'remote', 'add', 'origin', remote);
    box.git(box.repo, 'push', '-q', '-u', 'origin', 'main');
  }
  return box;
}

/** Submit a genuine branch changing both files, optionally using another joined lane seat. */
async function submit(box, number = 1) {
  const path = number === 1 ? box.web : join(box.dir, 'builder-' + number);
  if (number !== 1) {
    box.git(box.repo, 'worktree', 'add', '-q', '-b', 'web/conflict-' + number, path, 'main');
    const joined = joinFixtureSeat(box, path, 'web');
    assert.equal(joined.code, 0, joined.out + joined.err);
  }
  const added = (await json(box, box.repo, 'add', 'web', 'Conflict fixture ' + number, '--specs', 'G1',
    '--criterion', 'Both modules remain valid.', '--check', 'node --check ' + FILE));
  const id = added.item.item_id;
  (await json(box, path, 'claim', String(id)));
  for (const file of [FILE, SECOND]) writeFileSync(join(path, file), `export const value = "item-${number}";\n`);
  box.git(path, 'add', FILE, SECOND);
  box.git(path, 'commit', '-q', '-m', 'feat(web): build conflict fixture [G1]');
  const commit = box.git(path, 'rev-parse', 'HEAD');
  (await json(box, path, 'submit', String(id)));
  return { id, path, commit };
}

/** Independently check the private fixture submission before restoring its main checkout. */
async function accept(box, entry) {
  box.git(box.repo, 'switch', '-q', '--detach', entry.commit);
  try { (await json(box, box.repo, 'verify', String(entry.id), 'accept', '--as', 'coordinator', '--note', 'Both modules parse at the exact submitted commit.')); }
  finally { box.git(box.repo, 'switch', '-q', 'main'); }
}

/** Move main into a real conflict, and obtain the exact file list independently from Git. */
function conflict(box, entry) {
  for (const file of [FILE, SECOND]) writeFileSync(join(box.repo, file), 'export const value = "main";\n');
  box.git(box.repo, 'add', FILE, SECOND);
  box.git(box.repo, 'commit', '-q', '-m', 'chore: move the conflict fixture trunk');
  const merge = trunkMerge(box.repo, entry.commit);
  assert.deepEqual([...merge.files].sort(), [FILE, SECOND].sort(), 'Git establishes both conflicts');
  return merge;
}

/** Inspect original durable event bytes rather than trusting the command's completion message. */
function latest(box, id) {
  // @pullboard-board-file persistence: inspect the reopen event bytes committed by the separate native CLI command
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    const row = board.db.prepare("SELECT * FROM event WHERE item_id=? AND event_kind='reopen' ORDER BY event_id DESC LIMIT 1").get(id);
    assert.ok(row, 'a real reopen was appended');
    return { row, detail: JSON.parse(row.event_detail), item: store.getItem(board, id) };
  } finally { store.closeBoard(board); }
}

/** Every newly recorded conflict names all Git files and excludes even an explicitly supplied test cause. */
function assertConflict(record, files) {
  assert.equal(record.item.item_status, 'open');
  assert.ok(record.detail.conflict, 'the reopen carries structured conflict evidence');
  assert.ok(record.detail.causeDerivation, 'the reopen carries structured cause provenance');
  assert.deepEqual([...record.detail.conflict.files].sort(), [...files].sort());
  assert.deepEqual([...record.detail.causeDerivation.files].sort(), [...files].sort());
  assert.ok(record.detail.cause.startsWith('conflict:'));
  assert.ok(eventCauses(record.row).every(key => key.startsWith('conflict:')));
  assert.deepEqual(eventCauses(record.row).sort(), files.map(file => 'conflict:' + encodeURI(file)).sort());
  assert.equal(record.detail.landingFailure, undefined, 'a conflict is never recorded as a failed test');
}

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
    '--criterion', 'Both modules remain valid.', '--check', 'node --check ' + FILE));
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

test('local and inline landing trains record sibling conflict files [C7,B3]', async () => {
  for (const separate of [true, false]) {
    const box = project(separate);
    const first = (await submit(box, 1));
    const second = (await submit(box, 2));
    (await accept(box, first));
    (await accept(box, second));
    const landed = (await json(box, box.repo, 'land'));
    assert.deepEqual(landed.landed, [first.id]);
    assert.equal(landed.conflicts.length, 1);
    assert.deepEqual([...landed.conflicts[0].files].sort(), [FILE, SECOND].sort());
    assertConflict(latest(box, second.id), landed.conflicts[0].files);
  }
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
