/** @pullboard-test-input source-cell packages/moves */
/** @pullboard-test-loads packages/store/src/io/board.js src/claims.js packages/state/src/io/engine.js src/exchange.js packages/state/src/io/machine.js */
/** Real Git, SQLite and ordered-engine coverage for coordinator criterion reopen, called as the board move [V2,V6,H16]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import * as store from '../../store/index.js';
import {
  exportBoard,
  importBoard,
} from '../../store/index.js';
import {
  AGENT_GRANT_ENGINE,
  ENGINE_VERSION,
  QUOTED_LANDING_FAILURE_ENGINE,
  agentGrantMinimum,
  appliedSequence,
  applyEngineMove,
  applyRelayMove,
  engineReceipt,
  prepareEngineMove,
} from '../../state/index.js';
import { Refused } from '../../kernel/index.js';
import { correctedNoVerdictReopen } from '../../items/index.js';
import { firstRefusalArgs } from '../../items/index.js';
import { loadConfig } from '../../config/index.js';
import { criterionFreezer } from '../index.js';
import { cellBoard } from '../../board/tests/fixtures/cell-board.js';
import { cellClaim } from '../../store/tests/fixtures/cell.js';
import { cellItem } from '../../store/tests/fixtures/cell.js';
import { cellProject } from '../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../store/tests/fixtures/cell.js';
import { closeCellBoard } from '../../board/tests/fixtures/cell-board.js';
import { openCellBoard } from '../../board/tests/fixtures/cell-board.js';
import { submitFixture as submitBoardStateFixture } from '../../store/tests/fixtures/submit.js';
import { unpackRelease } from '../../gate/tests/fixtures/release/archive.js';

/** The model name the builder seat joins with. */
const BUILDER_MODEL = 'Fixture builder';

/** Write and commit one file in a checkout, returning the new commit. */
function commitFile(fx, cwd, file, body, message) {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), body);
  fx.project.git(cwd, 'add', file);
  fx.project.git(cwd, 'commit', '-q', '-m', message);
  return fx.project.git(cwd, 'rev-parse', 'HEAD');
}

/**
 * A real-Git project with a coordinator, a joined web builder worktree and an api reviewer seat on one real board, with a
 * landing behavior test and its source on main; no CLI runs. `at` moves the board clock, so a window is read on its own time.
 */
function fixture(t, { config = {} } = {}) {
  const project = cellProject(t, { real: true, gate: 'true', config });
  mkdirSync(join(project.repo, 'web'), { recursive: true });
  writeFileSync(join(project.repo, 'web', 'feature.js'), 'export const status = "PASS";\n');
  writeFileSync(join(project.repo, 'web', 'landing.test.js'), [
    "import assert from 'node:assert/strict';",
    "import { readFileSync } from 'node:fs';",
    "import { test } from 'node:test';",
    "test('keeps the landed behavior', () => assert.match(readFileSync(new URL('./feature.js', import.meta.url), 'utf8'), /export const status/u));",
    '',
  ].join('\n'));
  project.git(project.repo, 'add', 'web/feature.js', 'web/landing.test.js');
  project.git(project.repo, 'commit', '-q', '-m', 'test(web): add landing behavior check');
  const web = join(project.dir, 'web');
  project.git(project.repo, 'worktree', 'add', '-q', web, '-b', 'web/one');
  const clock = { time: Date.parse('2026-10-10T12:00:00Z'), now() { return new Date(this.time); } };
  const board = cellBoard(t, project.boardFile, clock, { real: true, gitRoot: project.repo });
  cellSeat(board, { lane: 'coordinator', path: project.repo });
  const builder = cellSeat(board, { lane: 'web', path: web, model: BUILDER_MODEL });
  const reviewer = cellSeat(board, { lane: 'api', path: join(project.dir, 'reviewer'), model: BUILDER_MODEL });
  return { project, board, clock, web, repo: project.repo, builder, reviewer, count: 0 };
}

/** Add, claim and submit a real item from the joined worktree: a real commit and a board-state submit. */
function submitItem(fx, { file = 'web/page.html', body = '<h1>Page</h1>\n', criterion = 'The page renders.', title = 'Corrected criterion', message = 'feat(web): page [G1]' } = {}) {
  const id = cellItem(fx.board, { lane: 'web', title, specIds: ['G1'], criterion, route: 'strong' }).item_id;
  cellClaim(fx.board, id, fx.builder, { root: fx.web });
  const commit = commitFile(fx, fx.web, file, body, message);
  const tree = fx.project.git(fx.web, 'rev-parse', 'HEAD^{tree}');
  submitBoardStateFixture(fx.board, id, { agentId: fx.builder.id, commit, tree });
  return { id, commit, tree };
}

/** Reserve the submission for the api reviewer seat. */
function reserve(fx, id) {
  return store.reserveReview(fx.board, id, { agentId: fx.reviewer.id, leaseMs: 60 * 60_000, policy: 'any' });
}

/** Accept an item at its submitted commit as its reviewer; the board-state acceptance runs no gate. */
function accept(fx, id, commit) {
  reserve(fx, id);
  return store.verify(fx.board, id, { agentId: fx.reviewer.id, decision: 'ACCEPT', policy: 'any', head: commit,
    digest: store.getItem(fx.board, id).item_frozen_digest, note: 'private frozen check passed; board-state fixture only' });
}

/** Submit and accept a landing fixture, the board state after the item is verified. */
function verifiedItem(fx, number, contents) {
  fx.count += 1;
  const item = submitItem(fx, { file: 'web/feature.js', body: contents, title: `Landing fixture ${number}`,
    criterion: `landing fixture ${number} remains valid`, message: `feat(web): submit landing fixture ${number} [G1]` });
  accept(fx, item.id, item.commit);
  return item;
}

/**
 * Run one board move through the CLI's local writer (guards, preparation, then the store move) and return its outcome:
 * `{ result }`, or `{ error }` holding the refusal exactly as the command prints it. Nothing is recorded in the relay cursor.
 */
function ordered(fx, operation, args, board = fx.board) {
  try { return { result: store.writeBoardCommand(board, operation, args, args[1]?.agentId ?? 'coordinator') }; }
  catch (error) {
    if (!(error instanceof Refused)) throw error;
    return { error };
  }
}

/** Reopen as the coordinator through the ordered engine. */
function reopenAs(fx, id, note, extra = {}, agentId = 'coordinator') {
  return ordered(fx, 'reopen', [id, { agentId, note, ...extra }]);
}

/** Read a complete public item projection from the fixture board. */
function readItem(fx, id) {
  return { ...store.getItem(fx.board, id), thread: store.itemThread(fx.board, id), verdicts: store.verdictsFor(fx.board, id) };
}

/** Create two isolated SQLite replicas from the fixture's current board snapshot. */
function replicaPair(t, fx) {
  const snapshot = exportBoard(fx.board);
  return ['one', 'two'].map((name) => {
    const replica = cellBoard(t, join(fx.project.dir, `${name}.sqlite`), undefined, { real: true });
    importBoard(replica, snapshot);
    return replica;
  });
}

/**
 * Shape a current export for an archived client, which predates the job tables.
 *
 * Why: 7d16c88b1f added job and job_step on open, and old exchange.js refuses any table it does not know.
 * fc85f1c3cb then moved each item's submit hand-off record from board_meta (`submit_handoff:<item>`) onto its gate job,
 * so the fixture boards now hold jobs. The old client reads the record from board_meta, so every item's newest
 * record-carrying step on a gate job goes back there and the job tables are dropped: the archived client gets the board it knew.
 * @param {any} snapshot
 * @returns {any}
 */
function legacySnapshot(snapshot) {
  const { job = [], job_step: jobStep = [], ...tables } = snapshot.tables;
  const records = new Map();
  for (const step of [...jobStep].sort((a, b) => b.job_step_id - a.job_step_id)) {
    const owner = job.find((row) => row.job_id === step.job_step_job);
    if (owner?.job_kind !== 'gate') continue;
    const record = JSON.parse(step.job_step_payload).record;
    if (record !== undefined && !records.has(owner.job_item)) records.set(owner.job_item, record);
  }
  const handoffs = [...records].map(([item, record]) => ({ meta_key: `submit_handoff:${item}`, meta_value: JSON.stringify(record) }));
  return { ...snapshot, tables: { ...tables, board_meta: [...(tables.board_meta ?? []), ...handoffs] } };
}

/**
 * Drop the derived fields an archived client never computed.
 *
 * Why: c85ddac55a added item_stage and the readiness engine added item_readiness_command to current item reads, and #9181 added the
 * three item_reservation columns; item_needs is the engine-gated field lookup.js adds; clients before them return the same row without them.
 * @param {any} row
 * @returns {any}
 */
function withoutStage(row) {
  const { item_stage: _stage, item_readiness_command: _readiness, item_reservation_holder: _holder, item_reservation_by: _by,
    item_reservation_at: _at, item_needs: _needs, ...rest } = row;
  return rest;
}

/** Accepted engine-9 source before verified-item reopening; the 0.8.8 tag is not yet published. */
const engine9Source = '314ef28751c44c96186b337cc4ace0fd8bf33d42';

/** Compare verified-item reopen behavior across engines 8 through 10 and the current receiver. */
async function assertLegacyVerifiedReopen(t, fx, item, note) {
  // Replay the failure evidence, excluding the automatic note's later human navigation suffix.
  note = note.replace(/; see landing failure evidence in pullboard show \d+$/u, '');
  for (const [version, reference] of [[8, 'v0.8.6'], [9, engine9Source], [10, 'v0.8.23']]) {
    const directory = mkdtempSync(join(tmpdir(), `pullboard-engine-${version}-verified-reopen-`));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const snapshot = exportBoard(fx.board);
    const move = { version: 1, engine: version, id: `legacy-verified-reopen-${version}`, operation: 'reopen',
      args: [item.id, { agentId: 'coordinator', note }], actor: 'coordinator' };
    const receipt = { sequence: 1, at: '2026-10-11T12:00:00.000Z', kind: 'move',
      sender: { kind: 'agent', userId: 'fixture-user', agent: 'coordinator' } };

    const currentReceiver = openCellBoard(join(directory, 'current.sqlite'));
    t.after(() => store.closeBoard(currentReceiver));
    importBoard(currentReceiver, snapshot);
    const before = store.getItem(currentReceiver, item.id);
    const currentResult = applyRelayMove(currentReceiver, move, receipt);
    if (version < 10) {
      assert.equal(currentResult.error?.code, 'NOT_SUBMITTED');
      assert.deepEqual(store.getItem(currentReceiver, item.id), before, `engine-${version} replay leaves the verified item row unchanged`);
      assert.equal(currentResult.error?.message, `item #${item.id} is verified, not submitted`, `the current engine preserves engine-${version} refusal ordering and message`);
    } else {
      assert.equal(currentResult.error, undefined, JSON.stringify(currentResult));
      assert.equal(store.getItem(currentReceiver, item.id).item_status, 'open', 'engine 10 introduces verified-item landing reopens');
    }

    const oldDirectory = join(directory, 'old-client');
    mkdirSync(oldDirectory);
    unpackRelease(reference, oldDirectory);
    const legacyEngine = await import(pathToFileURL(join(oldDirectory, 'src/engine.js')).href);
    const legacyStore = await import(pathToFileURL(join(oldDirectory, 'src/board.js')).href);
    const legacyExchange = await import(pathToFileURL(join(oldDirectory, 'src/exchange.js')).href);
    const legacyReceiver = legacyStore.openBoard(join(directory, 'legacy.sqlite'));
    t.after(() => legacyStore.closeBoard(legacyReceiver));
    legacyExchange.importBoard(legacyReceiver, legacySnapshot(snapshot));
    assert.equal((await import(pathToFileURL(join(oldDirectory, 'src/machine.js')).href)).ENGINE_VERSION, version);
    const legacyBefore = legacyStore.getItem(legacyReceiver, item.id);
    const legacyResult = legacyEngine.applyRelayMove(legacyReceiver, move, receipt);
    if (version < 10) {
      assert.equal(legacyResult.error?.code, 'NOT_SUBMITTED');
      assert.deepEqual(currentResult.error, legacyResult.error, `engine-${version} preserves the older refusal envelope`);
      assert.deepEqual(store.events(currentReceiver), legacyStore.events(legacyReceiver), `engine-${version} preserves the older refusal event history`);
      assert.deepEqual(legacyStore.getItem(legacyReceiver, item.id), legacyBefore, `the engine-${version} client keeps its submitted-only rule`);
    } else {
      assert.equal(legacyResult.error, undefined, JSON.stringify(legacyResult));
      assert.deepEqual(legacyStore.getItem(legacyReceiver, item.id), withoutStage(store.getItem(currentReceiver, item.id)));
      assert.deepEqual(legacyStore.events(legacyReceiver), store.events(currentReceiver), 'the actual engine-10 client and engine-11 source replay identical landing reopens');
    }

    const nextMove = prepareEngineMove(currentReceiver, 'reopen', [item.id, { agentId: 'coordinator', note }],
      { id: `engine10-verified-reopen-after-${version}`, actor: 'coordinator' });
    assert.equal(nextMove.engine, ENGINE_VERSION);
    const beforeFuture = legacyExchange.exportBoard(legacyReceiver);
    assert.throws(() => legacyEngine.applyRelayMove(legacyReceiver, nextMove, { ...receipt, sequence: 2 }),
      (error) => error.code === 'ENGINE_VERSION');
    assert.deepEqual(legacyExchange.exportBoard(legacyReceiver), beforeFuture, `engine ${version} refuses before applying the engine-10 return`);
    let nextTarget = currentReceiver;
    if (version === 10) {
      nextTarget = openCellBoard(join(directory, 'current-after-engine-10.sqlite'));
      t.after(() => store.closeBoard(nextTarget));
      importBoard(nextTarget, snapshot);
    }
    const nextResult = applyRelayMove(nextTarget, nextMove, { ...receipt, sequence: version === 10 ? 1 : 2 });
    assert.equal(nextResult.error, undefined, JSON.stringify(nextResult));
    assert.equal(store.getItem(nextTarget, item.id).item_status, 'open');
    assert.equal(nextResult.result.landingFailure.mergeCommit, note.match(/merge commit ([a-f0-9]{40})/u)[1]);
  }
}

test('moves.reopen.coordinator-submitted: clause 1: the coordinator reopens a submitted item without a verdict [V2,V6,O8]', (t) => {
  const fx = fixture(t);
  const submitted = submitItem(fx);
  reserve(fx, 1);

  const wrongCaller = reopenAs(fx, 1, 'criterion wording needs correction', {}, fx.builder.id);
  assert.equal(wrongCaller.error.code, 'COORDINATOR_ONLY');
  const missingNote = reopenAs(fx, 1, ' ');
  assert.equal(missingNote.error.code, 'NOTE_REQUIRED');

  assert.notEqual(fx.project.git(fx.repo, 'rev-parse', 'HEAD'), submitted.commit, 'the coordinator stays at its own head');
  const reopened = reopenAs(fx, 1, 'correct the frozen criterion, not the work');
  assert.equal(reopened.error, undefined, JSON.stringify(reopened));
  assert.equal(reopened.result.id, 1);
  assert.equal(reopened.result.commit, submitted.commit);
  const alreadyOpen = reopenAs(fx, 1, 'try twice');
  assert.equal(alreadyOpen.error.code, 'NOT_SUBMITTED');

  const item = store.getItem(fx.board, 1);
  assert.equal(item.item_status, 'open');
  assert.equal(item.item_commit, submitted.commit, 'the builder’s submitted commit remains on record');
  assert.equal(item.item_built_by, 'web-1');
  assert.equal(item.item_verdict, null, 'reopen records no verifier judgment');
  assert.equal(item.item_verified_by, null);
  assert.equal(item.item_review_by, null, 'the old review reservation is cleared without a release/cooldown');
  assert.deepEqual(store.stats(fx.board), {
    items: { open: 1, claimed: 0, submitted: 0, verified: 0, withdrawn: 0 },
    // c85ddac55a (pipeline stages) added the named stages beside the status counts.
    stages: { open: 1, building: 0, 'in the gate': 0, 'back with builder': 0, 'in review': 0, accepted: 0, landed: 0, withdrawn: 0 },
    accepted: 0, rejected: 0,
  });
  const last = store.events(fx.board).at(-1);
  assert.equal(last.event_kind, 'reopen');
  assert.equal(last.event_by, 'coordinator');
  assert.deepEqual(JSON.parse(last.event_detail), {
    commit: submitted.commit, note: 'correct the frozen criterion, not the work', judgment: null, model: store.agentModel(fx.board, 'coordinator'),
    cause: 'refusal:REOPENED', causeDerivation: { kind: 'reopen-category', coarse: true },
    pipelineCause: { type: 'other', cause: 'refusal:REOPENED', text: 'correct the frozen criterion, not the work' },
  });
  assert.equal(store.events(fx.board).some((event) => event.event_kind === 'release' && JSON.parse(event.event_detail).review), false);

  store.editItem(fx.board, 1, { agentId: 'coordinator', criterion: 'The page renders a heading.', reason: 'the fixture corrects its bar' });
  assert.equal(store.getItem(fx.board, 1).item_criterion, 'The page renders a heading.');
});

test('moves.reopen.note-cites-semicolon-test: a reopen note can cite a test whose name contains a semicolon [V2,V6,H16]', (t) => {
  const fx = fixture(t);
  const item = verifiedItem(fx, 61, 'export const status = "PASS_QUOTED";\n');
  const mergeCommit = 'b'.repeat(40);
  const note = `web/landing.test.js: "keeps; the \\"landed\\" behavior"; web/other.test.js: "finds; the event"; merge commit ${mergeCommit}`;
  const malformed = reopenAs(fx, item.id, `web/landing.test.js: "keeps; the landed behavior; merge commit ${mergeCommit}`);
  assert.equal(malformed.error.code, 'LANDING_FAILURE_REQUIRED');
  const malformedUnquoted = reopenAs(fx, item.id, `web/landing.test.js: ; merge commit ${mergeCommit}`);
  assert.equal(malformedUnquoted.error.code, 'LANDING_FAILURE_REQUIRED');
  assert.equal(readItem(fx, item.id).item_status, 'verified', 'an unclosed quoted attempt cannot fall back to the historical parser');

  const snapshot = exportBoard(fx.board);
  assert.match(malformed.error.next,
    /--note '<test file>: "<test name; with semicolon>"; merge commit <sha>'/u,
    'the refusal shows a shell-valid quoted form for a semicolon in the test name');
  assert.match(malformedUnquoted.error.next,
    /--note '<test file>: "<test name; with semicolon>"; merge commit <sha>'/u,
    'a current-engine refusal for an invalid unquoted note also shows the quoted form');
  const move = prepareEngineMove(fx.board, 'reopen', [item.id, { agentId: 'coordinator', note }]);
  assert.equal(move.args[1].quotedLandingFailure, true);
  assert.ok(move.engine >= QUOTED_LANDING_FAILURE_ENGINE);

  const markedReplica = cellBoard(t, ':memory:');
  importBoard(markedReplica, snapshot);
  const beforeOldFloor = exportBoard(markedReplica);
  assert.throws(() => applyRelayMove(markedReplica, { ...move, engine: QUOTED_LANDING_FAILURE_ENGINE - 1 }, {
    sequence: 1, at: '2026-10-24T12:00:00.000Z', kind: 'move',
    sender: { kind: 'agent', userId: 'fixture-user', agent: 'coordinator' },
  }), (error) => error.code === 'RELAY_MOVE');
  assert.deepEqual(exportBoard(markedReplica), beforeOldFloor, 'an unmarked pre-feature engine cannot partially apply the new grammar');
  const marked = applyRelayMove(markedReplica, move, {
    sequence: 1, at: '2026-10-24T12:00:00.000Z', kind: 'move',
    sender: { kind: 'agent', userId: 'fixture-user', agent: 'coordinator' },
  });
  assert.equal(marked.error, undefined, JSON.stringify(marked));
  assert.deepEqual(marked.result.landingFailure.tests, [
    { file: 'web/landing.test.js', name: 'keeps; the "landed" behavior' },
    { file: 'web/other.test.js', name: 'finds; the event' },
  ]);

  const reopened = reopenAs(fx, item.id, note);
  assert.equal(reopened.error, undefined, JSON.stringify(reopened));
  const expected = {
    batch: null,
    tests: [
      { file: 'web/landing.test.js', name: 'keeps; the "landed" behavior' },
      { file: 'web/other.test.js', name: 'finds; the event' },
    ],
    mergeCommit,
  };
  assert.deepEqual(reopened.result.landingFailure, expected);
  const returned = readItem(fx, item.id);
  assert.equal(returned.item_status, 'open');
  const event = returned.thread.findLast((entry) => entry.type === 'move' && entry.kind === 'reopen');
  assert.deepEqual(event.detail.landingFailure, expected);

  const historical = `test/a.test.js: "first; test/b.test.js: second"; merge commit ${'c'.repeat(40)}`;
  const legacyReplica = cellBoard(t, ':memory:');
  importBoard(legacyReplica, snapshot);
  const legacy = applyRelayMove(legacyReplica, {
    version: 1, engine: 10, id: 'legacy-quoted-manual', operation: 'reopen',
    args: [item.id, { agentId: 'coordinator', note: historical }], actor: 'coordinator',
  }, { sequence: 1, at: '2026-10-24T12:00:00.000Z', kind: 'move',
    sender: { kind: 'agent', userId: 'fixture-user', agent: 'coordinator' } });
  assert.equal(legacy.error, undefined, JSON.stringify(legacy));
  assert.deepEqual(legacy.result.landingFailure.tests, [
    { file: 'test/a.test.js', name: '"first' },
    { file: 'test/b.test.js', name: 'second"' },
  ], 'old unmarked moves retain the historical semicolon split');

  const legacyRefusalReplica = cellBoard(t, ':memory:');
  importBoard(legacyRefusalReplica, snapshot);
  const legacyRefusal = applyRelayMove(legacyRefusalReplica, {
    version: 1, engine: 10, id: 'legacy-quoted-refusal', operation: 'reopen',
    args: [item.id, { agentId: 'coordinator', note: 'not landing evidence' }], actor: 'coordinator',
  }, { sequence: 1, at: '2026-10-24T12:00:00.000Z', kind: 'move',
    sender: { kind: 'agent', userId: 'fixture-user', agent: 'coordinator' } });
  assert.equal(legacyRefusal.error?.code, 'LANDING_FAILURE_REQUIRED');
  assert.equal(legacyRefusal.error.message,
    `reopening verified item #${item.id} needs --note in the format <test file>: <test name>; merge commit <sha>`,
    'an old unmarked refusal retains its recorded-engine message');
  assert.equal(store.getItem(legacyRefusalReplica, item.id).item_status, 'verified');

  const unquotedItem = verifiedItem(fx, 62, 'export const status = "PASS_UNQUOTED";\n');
  const unquotedNote = `review context: web/landing.test.js: keeps the landed behavior; merge commit ${'c'.repeat(40)}`;
  const unquotedReopen = reopenAs(fx, unquotedItem.id, unquotedNote);
  assert.equal(unquotedReopen.error, undefined, JSON.stringify(unquotedReopen));
  assert.deepEqual(unquotedReopen.result.landingFailure.tests,
    [{ file: 'web/landing.test.js', name: 'keeps the landed behavior' }],
    'the current CLI preserves unquoted evidence found after prose');
});

test('moves.reopen.verified-returns-builder: clause 2: a verified item returns to its builder on recorded landing evidence and refuses malformed notes [B3,V4]', async (t) => {
  const fx = fixture(t);
  const item = verifiedItem(fx, 1, 'export const status = "RED";\n');
  const originalAccept = readItem(fx, item.id).thread.find((event) => event.type === 'move' && event.kind === 'accept');
  assert.ok(originalAccept, 'the item begins with an actual accept event');
  const landingNote = `Landing batch fixture_batch-1 failed web/landing.test.js: keeps the landed behavior; merge commit ${'a'.repeat(40)}; see landing failure evidence in pullboard show ${item.id}`;
  const nonCoordinator = reopenAs(fx, item.id, 'coordinator only', {}, fx.builder.id);
  assert.equal(nonCoordinator.error.code, 'COORDINATOR_ONLY');

  await assertLegacyVerifiedReopen(t, fx, item, landingNote);

  const generatedBoard = cellBoard(t, ':memory:');
  importBoard(generatedBoard, exportBoard(fx.board));
  assert.deepEqual(store.landingBatches(fx.board), [], 'hand-run landing evidence starts with no recorded batch');
  const generatedNote = `Landing batch fixture_batch-1 failed web/landing.test.js: first red; nested/roadmap.test.js: second red; merge commit ${'f'.repeat(40)}`;
  const generatedReopen = store.reopen(generatedBoard, item.id, { agentId: 'coordinator', note: generatedNote });
  assert.equal(store.getItem(generatedBoard, item.id).item_status, 'open');
  assert.deepEqual(generatedReopen.landingFailure, {
    batch: null,
    tests: [
      { file: 'web/landing.test.js', name: 'first red' },
      { file: 'nested/roadmap.test.js', name: 'second red' },
    ],
    mergeCommit: 'f'.repeat(40),
  }, 'the exact landing-generated note prefix retains every failure when the batch is absent');
  assert.deepEqual(JSON.parse(store.events(generatedBoard).at(-1).event_detail).landingFailure, generatedReopen.landingFailure,
    'the absent-batch fallback records every generated failure in immutable history');
  const noNamedTest = reopenAs(fx, item.id, `merge commit ${'d'.repeat(40)}`);
  assert.equal(noNamedTest.error.code, 'LANDING_FAILURE_REQUIRED');
  for (const invalidNote of [
    `Landing failed: gate red; merge commit ${'d'.repeat(40)}`,
    `Landing gate red on the runner: see the log; merge commit ${'d'.repeat(40)}`,
    `Reopening #12: the gate was red; merge commit ${'d'.repeat(40)}`,
  ]) {
    const refused = reopenAs(fx, item.id, invalidNote);
    assert.equal(refused.error.code, 'LANDING_FAILURE_REQUIRED', invalidNote);
    assert.equal(readItem(fx, item.id).item_status, 'verified', 'a malformed manual note leaves the item verified');
  }
  assert.match(noNamedTest.error.message,
    /<test file>: <test name>; merge commit <sha>/u, 'the refusal explains the exact manual evidence format');
  const manualNote = `web/landing.test.js: keeps the landed behavior; merge commit ${'d'.repeat(40)}`;
  const manual = reopenAs(fx, item.id, manualNote);
  assert.equal(manual.error, undefined, JSON.stringify(manual));
  const manuallyReturned = readItem(fx, item.id);
  assert.equal(manuallyReturned.item_status, 'open');
  const manualEvent = manuallyReturned.thread.filter((event) => event.type === 'move' && event.kind === 'reopen').at(-1);
  assert.equal(manualEvent.detail.supersedes, originalAccept.eventId);
  assert.deepEqual(manualEvent.detail.landingFailure, {
    batch: null,
    tests: [{ file: 'web/landing.test.js', name: 'keeps the landed behavior' }],
    mergeCommit: 'd'.repeat(40),
  });
  assert.ok(manuallyReturned.thread.some((event) => event.eventId === originalAccept.eventId && event.kind === 'accept'),
    'the prior manual accept remains immutable in history');

  // The builder reclaims, resubmits and is accepted afresh; the next return supersedes that newest accept.
  cellClaim(fx.board, item.id, fx.builder, { root: fx.web });
  const fix = commitFile(fx, fx.web, 'web/feature.js', 'export const status = "PASS_FIXED";\n', 'fix(web): restore landing behavior [G1]');
  submitBoardStateFixture(fx.board, item.id, { agentId: fx.builder.id, commit: fix, tree: fx.project.git(fx.web, 'rev-parse', 'HEAD^{tree}') });
  assert.equal(readItem(fx, item.id).item_verified_by, null, 'the older accept does not verify the resubmission');
  accept(fx, item.id, fix);
  const freshAccept = readItem(fx, item.id).thread.filter((event) => event.type === 'move' && event.kind === 'accept').at(-1);
  assert.notEqual(freshAccept.detail.commit, originalAccept.detail.commit);
  const returnedAgain = reopenAs(fx, item.id, `web/landing.test.js: keeps the landed behavior; merge commit ${'e'.repeat(40)}`);
  assert.equal(returnedAgain.error, undefined, JSON.stringify(returnedAgain));
  const returnedAgainEvent = readItem(fx, item.id).thread.filter((event) => event.type === 'move' && event.kind === 'reopen').at(-1);
  assert.equal(returnedAgainEvent.detail.supersedes, freshAccept.eventId);
  assert.equal(returnedAgainEvent.detail.landingFailure.batch, null);
});

/** The fixture environment without the parent test runner's context, so a nested `node --test` really runs. */
function nestedRunnerEnv(env) {
  const { NODE_TEST_CONTEXT: _context, ...rest } = env;
  return rest;
}

/** A real failing test on a real unrecorded two-parent merge of the accepted commit, then the manual return naming it. */
function manualMergeReturn(t, { file, name, body, noteFor, label }) {
  const fx = fixture(t);
  const item = verifiedItem(fx, 1, 'export const status = "RED";\n');
  mkdirSync(dirname(join(fx.repo, file)), { recursive: true });
  writeFileSync(join(fx.repo, file), body);
  fx.project.git(fx.repo, 'add', file);
  fx.project.git(fx.repo, 'commit', '-q', '-m', `test: guard ${label} landing behavior [G1]`);
  const merged = fx.project.tryGit(fx.repo, 'merge', '--no-ff', '--no-edit', item.commit);
  assert.equal(merged.status, 0, merged.failure ?? merged.stderr);
  const mergeCommit = fx.project.git(fx.repo, 'rev-parse', 'HEAD');
  const mergeParents = fx.project.git(fx.repo, 'rev-list', '--parents', '-n', '1', mergeCommit).split(' ');
  assert.equal(mergeParents.length, 3, 'the manual landing evidence names a real two-parent merge commit');
  assert.equal(mergeParents[2], item.commit, 'the second parent is the accepted item commit');
  const failing = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { cwd: fx.repo, env: nestedRunnerEnv(fx.project.env), encoding: 'utf8' });
  assert.equal(failing.status, 1, failing.stderr || failing.stdout);
  assert.match(failing.stdout, new RegExp(`not ok 1 - ${name}`, 'u'));

  assert.deepEqual(store.landingBatches(fx.board), [], 'a hand-run merge has no recorded landing batch');
  const accepted = readItem(fx, item.id).thread.findLast((event) => event.type === 'move' && event.kind === 'accept');
  assert.ok(accepted, 'the item has the original accept that the landing failure supersedes');
  const reopened = reopenAs(fx, item.id, noteFor(mergeCommit));
  assert.equal(reopened.error, undefined, JSON.stringify(reopened));
  const landingFailure = { batch: null, tests: [{ file, name }], mergeCommit };
  assert.deepEqual(reopened.result.landingFailure, landingFailure);
  const returned = readItem(fx, item.id);
  assert.equal(returned.item_status, 'open');
  assert.equal(returned.item_commit, item.commit, 'the accepted commit remains recorded');
  const reopenEvent = returned.thread.findLast((event) => event.type === 'move' && event.kind === 'reopen');
  assert.equal(reopenEvent.detail.supersedes, accepted.eventId);
  assert.deepEqual(reopenEvent.detail.landingFailure, landingFailure);
  assert.ok(returned.thread.some((event) => event.eventId === accepted.eventId && event.kind === 'accept'),
    'the append-only accept remains in history');
}

test('moves.reopen.manual-root-level-failing: manual reopen accepts a failing root-level test after an unrecorded two-parent merge [B3,V4]', (t) => {
  manualMergeReturn(t, {
    file: 'root.test.js', name: 'root-level landing behavior remains green', label: 'root-level',
    body: [
      "import assert from 'node:assert/strict';",
      "import { readFileSync } from 'node:fs';",
      "import { test } from 'node:test';",
      "test('root-level landing behavior remains green', () => assert.match(readFileSync(new URL('./web/feature.js', import.meta.url), 'utf8'), /export const status = [\"']PASS[\"']/u));",
      '',
    ].join('\n'),
    noteFor: (mergeCommit) => `root.test.js: root-level landing behavior remains green; merge commit ${mergeCommit}`,
  });
});

test('moves.reopen.manual-timestamp-prefixed: manual reopen records a timestamp-prefixed failing test after an unrecorded two-parent merge [B3,V4]', (t) => {
  manualMergeReturn(t, {
    file: 'test/a.test.js', name: 'keeps it', label: 'released',
    body: [
      "import assert from 'node:assert/strict';",
      "import { readFileSync } from 'node:fs';",
      "import { test } from 'node:test';",
      "test('keeps it', () => assert.match(readFileSync(new URL('../web/feature.js', import.meta.url), 'utf8'), /export const status = [\"']PASS[\"']/u));",
      '',
    ].join('\n'),
    noteFor: (mergeCommit) => `Gate red at 10:30, test/a.test.js: keeps it; merge commit ${mergeCommit}`,
  });
});

/** The coordinator's criterion freezer, as `refreeze` builds it for the checkout. */
function freezer(fx) {
  return criterionFreezer({ root: fx.repo, isMain: true, config: loadConfig(fx.repo) }, { captureVerifyPolicy: true, board: fx.board });
}

test('moves.reopen.same-commit-again: a reopened bar takes the same commit again [V2,V6,H16]', async (t) => {
  let engine10Store, engine10Exchange;
  const fx = fixture(t);
  const submitted = submitItem(fx);
  reserve(fx, 1);
  const copies = replicaPair(t, fx);
  assert.ok(ENGINE_VERSION >= 8, 'engine 8 introduces ordered reopen semantics');
  assert.ok(ENGINE_VERSION >= 10, 'engine 10 adds verified-item landing reopens');
  const move = prepareEngineMove(copies[0], 'reopen', [1, {
    agentId: 'coordinator', note: 'replay the no-verdict return',
  }], { id: 'reopen-engine-roundtrip', actor: 'coordinator' });
  assert.equal(move.engine, ENGINE_VERSION, "new moves use the current engine while legacy receipts retain their recorded engine");
  const oldReceiver = openCellBoard(join(fx.project.dir, 'old-engine.sqlite'));
  t.after(() => store.closeBoard(oldReceiver));
  importBoard(oldReceiver, exportBoard(copies[0]));
  const beforeOldReceiver = exportBoard(oldReceiver);
  const oldDirectory = mkdtempSync(join(tmpdir(), 'pullboard-engine-7-reopen-'));
  t.after(() => rmSync(oldDirectory, { recursive: true, force: true }));
  unpackRelease('v0.8.4', oldDirectory);
  const oldEngine = await import(pathToFileURL(join(oldDirectory, 'src/engine.js')).href);
  const oldMachine = await import(pathToFileURL(join(oldDirectory, 'src/machine.js')).href);
  assert.equal(oldMachine.ENGINE_VERSION, 7, 'retain coverage for the actual released engine-7 client');
  const sender = { kind: 'agent', userId: 'fixture-user', agent: 'coordinator' };
  assert.throws(() => oldEngine.applyRelayMove(oldReceiver, move, {
    sequence: 1, at: '2026-10-10T12:00:00.000Z', kind: 'move', sender,
  }), (error) => error.code === 'ENGINE_VERSION');
  assert.deepEqual(exportBoard(oldReceiver), beforeOldReceiver, 'the actual engine-7 client refuses the future move before changing rows or replay state');
  assert.equal(appliedSequence(oldReceiver), 0);

  assert.throws(() => applyRelayMove(oldReceiver, { ...move, engine: 7 }, {
    sequence: 1, at: '2026-10-10T12:00:00.000Z', kind: 'move', sender,
  }), (error) => error.code === 'RELAY_MOVE');
  assert.deepEqual(exportBoard(oldReceiver), beforeOldReceiver, 'the current receiver rejects an impossible pre-introduction tag without mutation');

  for (const [version, reference] of [[8, 'v0.8.6'], [9, engine9Source], [10, 'v0.8.23']]) {
    const legacyDirectory = mkdtempSync(join(tmpdir(), `pullboard-engine-${version}-reopen-`));
    t.after(() => rmSync(legacyDirectory, { recursive: true, force: true }));
    unpackRelease(reference, legacyDirectory);
    const legacyEngine = await import(pathToFileURL(join(legacyDirectory, 'src/engine.js')).href);
    const legacyStore = await import(pathToFileURL(join(legacyDirectory, 'src/board.js')).href);
    const legacyExchange = await import(pathToFileURL(join(legacyDirectory, 'src/exchange.js')).href);
    const legacyMachine = await import(pathToFileURL(join(legacyDirectory, 'src/machine.js')).href);
    assert.equal(legacyMachine.ENGINE_VERSION, version, `exercise the actual engine-${version} source`);
    if (version === 10) { engine10Store = legacyStore; engine10Exchange = legacyExchange; }
    const legacyReceiver = legacyStore.openBoard(join(fx.project.dir, `engine-${version}-reopen.sqlite`));
    t.after(() => legacyStore.closeBoard(legacyReceiver));
    const submittedSnapshot = exportBoard(copies[0]);
    legacyExchange.importBoard(legacyReceiver, legacySnapshot(submittedSnapshot));
    assert.throws(() => legacyEngine.applyRelayMove(legacyReceiver, move, {
      sequence: 1, at: '2026-10-10T12:00:00.000Z', kind: 'move', sender,
    }), (error) => error.code === 'ENGINE_VERSION');
    const legacyMove = { ...move, id: `legacy-engine${version}-reopen`, engine: version };
    const legacyResult = legacyEngine.applyRelayMove(legacyReceiver, legacyMove, {
      sequence: 1, at: '2026-10-10T12:00:00.000Z', kind: 'move', sender,
    });
    assert.equal(legacyResult.error, undefined, JSON.stringify(legacyResult));
    assert.deepEqual(legacyResult.result, { id: 1, commit: submitted.commit });
    const currentLegacyReceiver = openCellBoard(join(fx.project.dir, `current-engine-${version}-reopen.sqlite`));
    t.after(() => store.closeBoard(currentLegacyReceiver));
    importBoard(currentLegacyReceiver, submittedSnapshot);
    const currentLegacyResult = applyRelayMove(currentLegacyReceiver, legacyMove, {
      sequence: 1, at: '2026-10-10T12:00:00.000Z', kind: 'move', sender,
    });
    assert.equal(currentLegacyResult.error, undefined, JSON.stringify(currentLegacyResult));
    assert.deepEqual(currentLegacyResult.result, legacyResult.result);
    assert.deepEqual(withoutStage(store.getItem(currentLegacyReceiver, 1)), legacyStore.getItem(legacyReceiver, 1),
      `the current engine replays a submitted engine-${version} reopen as its older client did`);
  }

  const first = applyRelayMove(copies[0], move, { sequence: 1, at: '2026-10-10T12:00:00.000Z', kind: 'move', sender });
  const second = applyRelayMove(copies[1], move, { sequence: 1, at: '2026-10-10T12:00:00.000Z', kind: 'move', sender });
  assert.deepEqual(first, second);
  assert.deepEqual(first.result, {
    id: 1, commit: submitted.commit, cause: 'refusal:REOPENED',
    causeDerivation: { kind: 'reopen-category', coarse: true },
  });
  for (const replica of copies) {
    assert.equal(store.getItem(replica, 1).item_status, 'open');
    assert.equal(store.getItem(replica, 1).item_commit, submitted.commit);
    assert.equal(store.events(replica).at(-1).event_kind, 'reopen');
    assert.equal(JSON.parse(store.events(replica).at(-1).event_detail).judgment, null);
    assert.equal(appliedSequence(replica), 1);
    assert.equal(engineReceipt(replica, move.id).sequence, 1);
    const forged = { ...move, id: 'forged-reopen' };
    const refusal = applyRelayMove(replica, forged, {
      sequence: 2, at: '2026-10-10T12:00:01.000Z', kind: 'move',
      sender: { kind: 'agent', userId: 'fixture-user', agent: 'web-1' },
    });
    assert.equal(refusal.error.code, 'RELAY_SENDER_MISMATCH');
    const refusedEvent = store.events(replica, { itemId: 1 }).at(-1);
    assert.equal(refusedEvent.event_kind, 'relay_refused', 'a forged reopen is visible in the item history');
    assert.equal(refusedEvent.item_id, 1);
    assert.equal(refusedEvent.event_by, 'web-1');
    assert.equal(appliedSequence(replica), 2);
  }

  const reopened = reopenAs(fx, 1, 'correct the frozen criterion');
  assert.equal(reopened.error, undefined, JSON.stringify(reopened));
  cellClaim(fx.board, 1, fx.builder, { root: fx.web });
  const resubmit = () => submitBoardStateFixture(fx.board, 1, { agentId: fx.builder.id, commit: submitted.commit, tree: submitted.tree });
  assert.throws(resubmit, (error) => error.code === 'HEAD_NOT_NEW', 'a no-verdict reopen alone does not make the old bar a new submission');
  store.release(fx.board, 1, fx.builder.id, '', undefined, 'BLOCKED');
  const explicitRefreeze = ordered(fx, 'refreeze', [1, { agentId: 'coordinator', freeze: freezer(fx) }]);
  assert.equal(explicitRefreeze.error, undefined, JSON.stringify(explicitRefreeze));
  cellClaim(fx.board, 1, fx.builder, { root: fx.web });
  resubmit();
  assert.equal(store.getItem(fx.board, 1).item_status, 'submitted');
  assert.equal(store.getItem(fx.board, 1).item_commit, submitted.commit,
    'an explicit coordinator refreeze is a new frozen bar even when its text is unchanged');

  const secondReopen = reopenAs(fx, 1, 'correct the frozen criterion to match the implemented heading');
  assert.equal(secondReopen.error, undefined, JSON.stringify(secondReopen));
  store.editItem(fx.board, 1, { agentId: 'coordinator', criterion: 'The page renders a heading.', reason: 'the fixture corrects its bar' });
  assert.equal(correctedNoVerdictReopen(fx.board, 1, submitted.commit), false,
    'an atomic correction alone cannot replace the matching post-correction claim');

  cellClaim(fx.board, 1, fx.builder, { root: fx.web });
  assert.equal(correctedNoVerdictReopen(fx.board, 1, submitted.commit), true,
    'the real new claim binds the canonical corrected frozen bar');
  assert.equal(correctedNoVerdictReopen(fx.board, 1, '0'.repeat(40)), false,
    'the correction never authorizes a different previous submission');
  // Model the historical proofless wire explicitly; modern preparation adds later clause-policy fields.
  const engine11Move = { version: 1, engine: 11, id: 'same-commit-engine-11', operation: 'submit', actor: 'web-1',
    args: [1, { agentId: 'web-1', commit: submitted.commit, tree: submitted.tree,
      policyCommit: fx.project.git(fx.repo, 'rev-parse', 'HEAD') }] };
  const builderSender = { kind: 'agent', userId: 'fixture-user', agent: 'web-1' };
  const engine10Replica = openCellBoard(join(fx.project.dir, 'engine-10-same-commit.sqlite'));
  t.after(() => store.closeBoard(engine10Replica));
  const engine10Move = { ...engine11Move, id: 'same-commit-engine-10', engine: 10 };
  const markedReplica = openCellBoard(join(fx.project.dir, 'modern-grant-same-commit.sqlite'));
  t.after(() => store.closeBoard(markedReplica));
  importBoard(markedReplica, exportBoard(fx.board));
  assert.equal(agentGrantMinimum(markedReplica, engine10Move), AGENT_GRANT_ENGINE, 'the current claim retains its exact grant-engine floor');
  assert.throws(() => applyRelayMove(markedReplica, engine10Move, {
    sequence: 1, at: '2026-10-10T12:00:02.000Z', kind: 'move', sender: builderSender,
  }), error => error.code === 'RELAY_MOVE' && Number(/use engine (\d+) or newer/u.exec(error.message)?.[1]) >= AGENT_GRANT_ENGINE,
  'an engine-10 move cannot interpret the current grant or any later active policy');

  // Seed the historical lifecycle with the actual released engine-10 writer, not by deleting modern markers.
  // These are board-state fixtures only: neither direct submit call claims an executed gate.
  const legacySeed = engine10Store.openBoard(join(fx.project.dir, 'actual-engine10-submit-state.sqlite'));
  t.after(() => engine10Store.closeBoard(legacySeed));
  engine10Store.register(legacySeed, { lane: 'coordinator', path: fx.repo });
  const legacyBuilder = engine10Store.register(legacySeed, { lane: 'web', path: fx.web });
  const initialItem = store.getItem(copies[0], 1), correctedItem = store.getItem(fx.board, 1);
  const legacyId = engine10Store.addItem(legacySeed, { by: 'coordinator', lane: 'web', title: initialItem.item_title,
    criterion: initialItem.item_criterion, check: initialItem.item_check });
  /** Reuse each criterion's real frozen bytes while the released writer records its own historical claim. */
  const historicalFreeze = item => () => ({ text: item.item_frozen, digest: item.item_frozen_digest });
  engine10Store.claim(legacySeed, legacyId, { agentId: legacyBuilder, lane: 'web', leaseMs: 60_000,
    freeze: historicalFreeze(initialItem) });
  engine10Store.submit(legacySeed, legacyId, { agentId: legacyBuilder, commit: submitted.commit, tree: submitted.tree });
  engine10Store.reopen(legacySeed, legacyId, { agentId: 'coordinator', note: 'Historical criterion correction' });
  engine10Store.editItem(legacySeed, legacyId, { agentId: 'coordinator', criterion: correctedItem.item_criterion });
  engine10Store.claim(legacySeed, legacyId, { agentId: legacyBuilder, lane: 'web', leaseMs: 60_000,
    freeze: historicalFreeze(correctedItem) });
  const historicalSnapshot = engine10Exchange.exportBoard(legacySeed);
  assert.ok(historicalSnapshot.tables.event.filter(row => ['join', 'claim'].includes(row.event_kind))
    .every(row => JSON.parse(row.event_detail).grantEngine === undefined), 'the actual old writer emitted no future grant marker');
  importBoard(engine10Replica, historicalSnapshot);
  const oldBehavior = applyRelayMove(engine10Replica, engine10Move, {
    sequence: 1, at: '2026-10-10T12:00:02.000Z', kind: 'move', sender: builderSender,
  });
  assert.equal(oldBehavior.error?.code, 'HEAD_NOT_NEW', 'engine 10 replay keeps the previous no-verdict reopen refusal');

  resubmit();
  assert.equal(store.getItem(fx.board, 1).item_commit, submitted.commit, 'the corrected bar accepts the original commit without inventing an empty commit');
  reserve(fx, 1);
  store.verify(fx.board, 1, { agentId: fx.reviewer.id, decision: 'REJECT', reason: 'BEHAVIOR_MISMATCH', clause: 'The page renders a heading.',
    note: 'the corrected criterion still fails', policy: 'any', head: submitted.commit, digest: store.getItem(fx.board, 1).item_frozen_digest });
  cellClaim(fx.board, 1, fx.builder, { root: fx.web });
  assert.throws(resubmit, (error) => error.code === 'HEAD_NOT_NEW', 'a rejection at the current corrected digest still blocks the same commit');
  assert.equal(store.getItem(fx.board, 1).item_status, 'claimed');
  assert.equal(store.getItem(fx.board, 1).item_verdict, 'REJECT');
});

test('moves.reopen.reviewer-withdraws-accept: a reviewer withdraws its own accept before landing and the builder gets the item back [V2,V6,H16]', (t) => {
  /** Give an accepted private item a real reviewer and an enabled builder-return window. */
  const withdrawalFixture = () => {
    const fx = fixture(t, { config: { claim: { reopenFirstRefusalMinutes: 30 } } });
    const submitted = submitItem(fx);
    accept(fx, 1, submitted.commit);
    const original = fx.board.db.prepare('SELECT * FROM verdict WHERE item_id = ?').get(1);
    return { fx, original, submitted };
  };
  /** Reopen through the ordered move with the coordinator's enabled window copied in, as the command does. */
  const withdraw = (fx, agentId, note, extra = {}) => ordered(fx, 'reopen', firstRefusalArgs('reopen',
    [1, { agentId, withdrawVerdict: true, note, ...extra }], loadConfig(fx.repo)));
  for (const coordinator of [false, true]) {
    const { fx, original, submitted } = withdrawalFixture();
    const board = fx.board;
    const initial = store.itemThread(board, 1).find(row => row.kind === 'accept');
    if (coordinator) {
      const stranger = withdraw(fx, fx.builder.id, 'not my verdict');
      assert.equal(stranger.error.code, 'VERDICT_WITHDRAW_FORBIDDEN');
      const missing = withdraw(fx, 'coordinator', ' ');
      assert.equal(missing.error.code, 'NOTE_REQUIRED');
    }
    const result = withdraw(fx, coordinator ? 'coordinator' : fx.reviewer.id, 'the accepted interpretation missed a recorded ruling');
    assert.equal(result.error, undefined, JSON.stringify(result));
    const item = store.getItem(board, 1);
    assert.equal(item.item_status, 'open');
    assert.equal(item.item_built_by, 'web-1');
    assert.equal(item.item_commit, submitted.commit);
    assert.equal(item.item_verdict, null);
    assert.equal(item.item_verified_by, null);
    assert.deepEqual(board.db.prepare('SELECT * FROM verdict WHERE item_id = ?').get(1), original,
      'the original verdict row is immutable');
    const verdict = store.verdictsFor(board, 1)[0];
    assert.equal(verdict.withdrawn, true);
    assert.match(verdict.withdrawal.note, /recorded ruling/u);
    const thread = store.itemThread(board, 1);
    const accepted = thread.find(row => row.kind === 'accept');
    assert.equal(accepted.eventId, initial.eventId);
    assert.deepEqual(accepted.detail, initial.detail, 'the recorded acceptance detail is not rewritten');
    assert.equal(accepted.withdrawn, true, 'history marks the exact earlier accept withdrawn');
    const returned = thread.findLast(row => row.kind === 'reopen');
    assert.equal(returned.detail.withdrawnVerdict.verdictId, original.verdict_id);
    assert.equal(returned.detail.withdrawnVerdict.acceptEventId, initial.eventId);
    assert.equal(returned.detail.reopenFirstRefusal.builder, 'web-1');
    assert.equal(Date.parse(returned.detail.reopenFirstRefusal.until) - Date.parse(returned.at), 30 * 60_000);
    cellClaim(board, 1, fx.builder, { root: fx.web });
    assert.equal(store.getItem(board, 1).item_status, 'claimed', 'the original builder can resume normally');
  }
  const { fx, submitted } = withdrawalFixture();
  fx.project.git(fx.repo, 'merge', '-q', '--no-edit', submitted.commit);
  store.merged(fx.board, 1, { agentId: 'coordinator', commit: fx.project.git(fx.repo, 'rev-parse', 'HEAD') });
  for (const agentId of ['coordinator', fx.reviewer.id]) {
    const refused = withdraw(fx, agentId, 'too late');
    assert.equal(refused.error.code, 'ALREADY_MERGED');
  }
});
