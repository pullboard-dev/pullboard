/** @pullboard-test-loads packages/store/src/io/board.js src/claims.js packages/state/src/io/engine.js src/exchange.js packages/state/src/io/machine.js */
/** Real Git, SQLite and ordered-engine coverage for coordinator criterion reopen [V2,V6,H16]. */
import { agentGrantMinimum } from '../../../../packages/state/index.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import {
  appliedSequence,
  applyRelayMove,
  engineReceipt,
  prepareEngineMove,
} from '../../../../packages/state/src/io/engine.js';
import {
  exportBoard,
  importBoard,
} from '../../../../packages/store/index.js';
import { ENGINE_VERSION } from '../../../../packages/state/src/io/machine.js';
import { QUOTED_LANDING_FAILURE_ENGINE } from '../../../../packages/state/src/logic/engines/quoted-landing-failure-engine.js';
import { AGENT_GRANT_ENGINE } from '../../../../packages/state/src/logic/engines/agent-grant-engine.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { safeFixtureDiagnostic } from '../../tests/fixtures/child.js';
import { correctedNoVerdictReopen } from '../../../../packages/items/index.js';
import { unpackRelease } from '../../tests/fixtures/release/archive.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { commitFile } = e2e;

/** Complete each private submit before inspecting state and suppress unrelated next-work dispatch. */
function project(...args) {
  const box = e2e.project(...args);
  const run = box.run;
  box.run = (cwd, ...argv) => {
    if (argv[0] === 'submit') argv.push('--wait', '--no-next');
    if (argv[0] === 'join' && !argv.includes('--model')) argv.push('--model', BUILDER_MODEL);
    if (argv[0] === 'join' && !argv.includes('--route')) argv.push('--route', 'strong');
    if (argv[0] === 'verify') argv.push('--no-next');
    return run(cwd, ...argv);
  };
  return box;
}

/** The model name fixture seats join with. */
const BUILDER_MODEL = 'Fixture builder';
/** The model a reopen event records when none was given. */
const UNRECORDED_MODEL = 'unknown';

/** Await the production CLI for fixture setup and moves while retaining the real submit worker and gate. */
function fixtureCommand(box, cwd, ...args) {
  if (args[0] === 'submit') args.push('--wait', '--no-next');
  if (args[0] === 'verify') args.push('--no-next');
  if (args[0] === 'join' && !args.includes('--model')) args.push('--model', BUILDER_MODEL);
  if (args[0] === 'join' && !args.includes('--route')) args.push('--route', 'strong');
  return runCliInProcess(args, { cwd, env: box.env });
}

/** Run repeated reopen probes through awaited production parsing and native board dispatch. */
function reopenCommand(box, cwd, ...args) {
  return runCliInProcess(['reopen', ...args], { cwd, env: box.env });
}

/** Open the real board SQLite file created by the CLI fixture and close it with the test. */
function openFixtureBoard(t, box) {
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  return board;
}

/** Create two isolated SQLite replicas from the submitted fixture's real board snapshot. */
function replicaPair(t, box) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-reopen-relay-'));
  const source = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  const snapshot = exportBoard(source);
  store.closeBoard(source);
  const copies = ['one', 'two'].map((name) => {
    const replica = openBoard(join(directory, `${name}.sqlite`));
    importBoard(replica, snapshot);
    return replica;
  });
  t.after(() => {
    for (const replica of copies) store.closeBoard(replica);
    rmSync(directory, { recursive: true, force: true });
  });
  return copies;
}

/** Add, claim and submit a real item through its joined Git worktree. */
async function submitFixture(box) {
  const added = (await fixtureCommand(box, box.repo, 'add', 'web', 'Corrected criterion', '--specs', 'G1', '--criterion', 'The page renders.', '--route', 'strong'));
  assert.equal(added.code, 0, added.err);
  const claimed = (await fixtureCommand(box, box.web, 'claim', '1'));
  assert.equal(claimed.code, 0, claimed.err);
  const commit = commitFile(box, box.web, 'web/page.html', '<h1>Page</h1>', 'feat(web): page [G1]');
  assert.equal(commit.status, 0, commit.stderr);
  const submitted = (await fixtureCommand(box, box.web, 'submit', '1'));
  assert.equal(submitted.code, 0, submitted.err);
  return { commit: box.git(box.web, 'rev-parse', 'HEAD'), tree: box.git(box.web, 'rev-parse', 'HEAD^{tree}') };
}

/** Reserve the real submission from a separate joined reviewer checkout. */
async function reserveFixtureReview(box) {
  const reviewPath = join(box.dir, 'reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', reviewPath, '-b', 'review/one');
  const joined = (await fixtureCommand(box, reviewPath, 'join', 'api'));
  assert.equal(joined.code, 0, joined.err);
  const reserved = (await fixtureCommand(box, reviewPath, 'next', '--verify', '1'));
  assert.equal(reserved.code, 0, reserved.err);
  return reviewPath;
}

/** Configure a real private main, joined builder, failing landing test and bare origin. */
function landingProject() {
  const box = project('node --test --test-reporter=tap web/landing.test.js');
  // The private landing runs a real nested Node test runner, not the parent's test worker.
  delete box.env.NODE_TEST_CONTEXT;
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web', 'feature.js'), 'export const status = "PASS";\n');
  writeFileSync(join(box.repo, 'web', 'landing.test.js'), [
    "import assert from 'node:assert/strict';",
    "import { readFileSync } from 'node:fs';",
    "import { test } from 'node:test';",
    "test('keeps the landed behavior', () => assert.match(readFileSync(new URL('./feature.js', import.meta.url), 'utf8'), /export const status/u));",
    '',
  ].join('\n'));
  const configPath = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.affectedTests = 'node --test --test-reporter=tap';
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  box.git(box.repo, 'add', 'web/landing.test.js', 'web/feature.js', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'test(web): add landing behavior check');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const remote = join(box.dir, 'origin.git');
  box.git(box.dir, 'init', '-q', '--bare', remote);
  box.git(box.repo, 'remote', 'add', 'origin', remote);
  box.git(box.repo, 'push', '-q', '-u', 'origin', 'main');
  return { ...box, remote };
}

/** Add a real trunk regression after review, so only combining it with the candidate turns red. */
function requireLandingBehavior(box) {
  const file = join(box.repo, 'web', 'landing.test.js');
  const previous = readFileSync(file, 'utf8');
  writeFileSync(file, previous.replace('assert.match', 'assert.doesNotMatch').replace('/export const status/u', '/RED/u'));
  box.git(box.repo, 'add', 'web/landing.test.js');
  box.git(box.repo, 'commit', '-q', '-m', 'test(web): check behavior during integration [G1]');
  box.git(box.repo, 'push', '-q', 'origin', 'main');
}

/** Add and submit an item using its real joined Git worktree and frozen syntax check. */
async function submitLandingFixture(box, number, contents, cwd = box.web) {
  if (cwd !== box.web) {
    box.git(box.repo, 'worktree', 'add', '-q', '-b', `web/landing-${number}`, cwd, 'main');
    assert.match((await fixtureCommand(box, cwd, 'join', 'web')).out, /joined as web-/u);
  }
  const added = (await fixtureCommand(box, box.repo, 'add', 'web', `Landing fixture ${number}`, '--specs', 'G1', '--route', 'strong', '--criterion', `landing fixture ${number} remains valid`,
    '--check', 'node --check web/feature.js', '--json'));
  assert.equal(added.code, 0, added.err);
  const id = JSON.parse(added.out).item.item_id;
  assert.equal((await fixtureCommand(box, cwd, 'claim', String(id))).code, 0);
  const committed = commitFile(box, cwd, 'web/feature.js', contents, `feat(web): submit landing fixture ${number} [G1]`);
  assert.equal(committed.status, 0, committed.stderr);
  const commit = box.git(cwd, 'rev-parse', 'HEAD');
  const submitted = (await fixtureCommand(box, cwd, 'submit', String(id)));
  assert.equal(submitted.code, 0, submitted.err);
  return { id, cwd, commit };
}

/** Accept an item at its actual submitted commit, then restore the coordinator's main checkout. */
async function acceptLandingFixture(box, item) {
  box.git(box.repo, 'switch', '-q', '--detach', item.commit);
  try {
    const result = (await fixtureCommand(box, box.repo, 'verify', String(item.id), 'accept', '--as', 'coordinator', '--note', 'private landing fixture passed its frozen check'));
    assert.equal(result.code, 0, result.err);
  } finally { box.git(box.repo, 'switch', '-q', 'main'); }
}

/** Read a complete public item projection through a short-lived board connection. */
function readItem(box, id) {
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try { return { ...store.getItem(board, id), thread: store.itemThread(board, id), verdicts: store.verdictsFor(board, id) }; }
  finally { store.closeBoard(board); }
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
 * Drop the derived pipeline stage an archived client never computed.
 *
 * Why: c85ddac55a added item_stage to current item reads; clients before it return the same row without it.
 * @param {any} row
 * @returns {any}
 */
function withoutStage(row) {
  const { item_stage: _stage, ...rest } = row;
  return rest;
}

/** Accepted engine-9 source before verified-item reopening; the 0.8.8 tag is not yet published. */
const engine9Source = '314ef28751c44c96186b337cc4ace0fd8bf33d42';

/** Compare verified-item reopen behavior across engines 8 through 10 and the current receiver. */
async function assertLegacyVerifiedReopen(t, box, item, note) {
  // Replay the failure evidence, excluding the automatic note's later human navigation suffix.
  note = note.replace(/; see landing failure evidence in pullboard show \d+$/u, '');
  for (const [version, reference] of [[8, 'v0.8.6'], [9, engine9Source], [10, 'v0.8.23']]) {
    const directory = mkdtempSync(join(tmpdir(), `pullboard-engine-${version}-verified-reopen-`));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const source = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
    const snapshot = exportBoard(source);
    store.closeBoard(source);
    const move = { version: 1, engine: version, id: `legacy-verified-reopen-${version}`, operation: 'reopen',
      args: [item.id, { agentId: 'coordinator', note }], actor: 'coordinator' };
    const receipt = { sequence: 1, at: '2026-10-11T12:00:00.000Z', kind: 'move',
      sender: { kind: 'agent', userId: 'fixture-user', agent: 'coordinator' } };

    const currentReceiver = openBoard(join(directory, 'current.sqlite'));
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
      nextTarget = openBoard(join(directory, 'current-after-engine-10.sqlite'));
      t.after(() => store.closeBoard(nextTarget));
      importBoard(nextTarget, snapshot);
    }
    const nextResult = applyRelayMove(nextTarget, nextMove, { ...receipt, sequence: version === 10 ? 1 : 2 });
    assert.equal(nextResult.error, undefined, JSON.stringify(nextResult));
    assert.equal(store.getItem(nextTarget, item.id).item_status, 'open');
    assert.equal(nextResult.result.landingFailure.mergeCommit, note.match(/merge commit ([a-f0-9]{40})/u)[1]);
  }
}

test('clause 1: the coordinator reopens a submitted item without a verdict [V2,V6,O8]', async (t) => {
  const box = project();
  const submitted = await submitFixture(box);
  await reserveFixtureReview(box);

  const wrongCaller = await reopenCommand(box, box.web, '1', '--note', 'criterion wording needs correction', '--json');
  assert.equal(wrongCaller.code, 1);
  assert.equal(JSON.parse(wrongCaller.out).error.code, 'COORDINATOR_ONLY');
  const missingNote = await reopenCommand(box, box.repo, '1', '--note', ' ', '--json');
  assert.equal(missingNote.code, 1);
  assert.equal(JSON.parse(missingNote.out).error.code, 'NOTE_REQUIRED');

  assert.notEqual(box.git(box.repo, 'rev-parse', 'HEAD'), submitted.commit, 'the coordinator stays at its own head');
  const reopened = await reopenCommand(box, box.repo, '1', '--note', 'correct the frozen criterion, not the work', '--json');
  assert.equal(reopened.code, 0, reopened.err);
  const result = JSON.parse(reopened.out);
  assert.equal(result.version, 1);
  assert.equal(result.id, 1);
  assert.equal(result.commit, submitted.commit);
  const alreadyOpen = await reopenCommand(box, box.repo, '1', '--note', 'try twice', '--json');
  assert.equal(alreadyOpen.code, 1);
  assert.equal(JSON.parse(alreadyOpen.out).error.code, 'NOT_SUBMITTED');

  const board = openFixtureBoard(t, box);
  const item = store.getItem(board, 1);
  assert.equal(item.item_status, 'open');
  assert.equal(item.item_commit, submitted.commit, 'the builder’s submitted commit remains on record');
  assert.equal(item.item_built_by, 'web-1');
  assert.equal(item.item_verdict, null, 'reopen records no verifier judgment');
  assert.equal(item.item_verified_by, null);
  assert.equal(item.item_review_by, null, 'the old review reservation is cleared without a release/cooldown');
  assert.deepEqual(store.stats(board), {
    items: { open: 1, claimed: 0, submitted: 0, verified: 0, withdrawn: 0 },
    // c85ddac55a (pipeline stages) added the named stages beside the status counts.
    stages: { open: 1, building: 0, 'in the gate': 0, 'back with builder': 0, 'in review': 0, accepted: 0, landed: 0, withdrawn: 0 },
    accepted: 0, rejected: 0,
  });
  const last = store.events(board).at(-1);
  assert.equal(last.event_kind, 'reopen');
  assert.equal(last.event_by, 'coordinator');
  assert.deepEqual(JSON.parse(last.event_detail), {
    commit: submitted.commit, note: 'correct the frozen criterion, not the work', judgment: null, model: UNRECORDED_MODEL,
    cause: 'refusal:REOPENED', causeDerivation: { kind: 'reopen-category', coarse: true },
    pipelineCause: { type: 'other', cause: 'refusal:REOPENED', text: 'correct the frozen criterion, not the work' },
  });
  assert.equal(store.events(board).some((event) => event.event_kind === 'release' && JSON.parse(event.event_detail).review), false);

  const edited = (await fixtureCommand(box, box.repo, 'edit', '1', '--criterion', 'The page renders a heading.', '--reason', 'the fixture corrects its bar'));
  assert.equal(edited.code, 0, edited.err);
  assert.equal(store.getItem(board, 1).item_criterion, 'The page renders a heading.');
});

test('a reopen note can cite a test whose name contains a semicolon [V2,V6,H16]', async () => {
  const box = landingProject();
  const item = await submitLandingFixture(box, 61, 'export const status = "PASS_QUOTED";\n');
  await acceptLandingFixture(box, item);
  const mergeCommit = 'b'.repeat(40);
  const note = `web/landing.test.js: "keeps; the \\"landed\\" behavior"; web/other.test.js: "finds; the event"; merge commit ${mergeCommit}`;
  const malformed = await reopenCommand(box, box.repo, String(item.id), '--note',
    `web/landing.test.js: "keeps; the landed behavior; merge commit ${mergeCommit}`, '--json');
  assert.equal(malformed.code, 1);
  assert.equal(JSON.parse(malformed.out).error.code, 'LANDING_FAILURE_REQUIRED');
  const malformedUnquoted = await reopenCommand(box, box.repo, String(item.id), '--note',
    `web/landing.test.js: ; merge commit ${mergeCommit}`, '--json');
  assert.equal(malformedUnquoted.code, 1);
  assert.equal(JSON.parse(malformedUnquoted.out).error.code, 'LANDING_FAILURE_REQUIRED');
  assert.equal(readItem(box, item.id).item_status, 'verified', 'an unclosed quoted attempt cannot fall back to the historical parser');

  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  let snapshot;
  try {
    snapshot = exportBoard(board);
  }
  finally { store.closeBoard(board); }

  const reopened = await reopenCommand(box, box.repo, String(item.id), '--note', note, '--json');
  assert.equal(reopened.code, 0, [reopened.err, reopened.out].filter(Boolean).join('\n'));
  assert.match(JSON.parse(malformed.out).error.next,
    /--note '<test file>: "<test name; with semicolon>"; merge commit <sha>'/u,
    'the refusal shows a shell-valid quoted form for a semicolon in the test name');
  assert.match(JSON.parse(malformedUnquoted.out).error.next,
    /--note '<test file>: "<test name; with semicolon>"; merge commit <sha>'/u,
    'a current-engine refusal for an invalid unquoted note also shows the quoted form');
  const moveBoard = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  let move;
  try {
    move = prepareEngineMove(moveBoard, 'reopen', [item.id, { agentId: 'coordinator', note }]);
    assert.equal(move.args[1].quotedLandingFailure, true);
    assert.ok(move.engine >= QUOTED_LANDING_FAILURE_ENGINE);
  }
  finally { store.closeBoard(moveBoard); }

  const markedReplica = openBoard(':memory:');
  try {
    importBoard(markedReplica, snapshot);
    const beforeOldFloor = exportBoard(markedReplica);
    assert.throws(() => applyRelayMove(markedReplica, { ...move, engine: QUOTED_LANDING_FAILURE_ENGINE - 1 }, {
      sequence: 1, at: '2026-10-24T12:00:00.000Z', kind: 'move',
      sender: { kind: 'agent', userId: 'fixture-user', agent: 'coordinator' },
    }), (error) => error.code === 'RELAY_MOVE');
    assert.deepEqual(exportBoard(markedReplica), beforeOldFloor, 'an unmarked pre-feature engine cannot partially apply the new grammar');
    const result = applyRelayMove(markedReplica, move, {
      sequence: 1, at: '2026-10-24T12:00:00.000Z', kind: 'move',
      sender: { kind: 'agent', userId: 'fixture-user', agent: 'coordinator' },
    });
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.deepEqual(result.result.landingFailure.tests, [
      { file: 'web/landing.test.js', name: 'keeps; the "landed" behavior' },
      { file: 'web/other.test.js', name: 'finds; the event' },
    ]);
  }
  finally { store.closeBoard(markedReplica); }

  const expected = {
    batch: null,
    tests: [
      { file: 'web/landing.test.js', name: 'keeps; the "landed" behavior' },
      { file: 'web/other.test.js', name: 'finds; the event' },
    ],
    mergeCommit,
  };
  assert.deepEqual(JSON.parse(reopened.out).landingFailure, expected);
  const returned = readItem(box, item.id);
  assert.equal(returned.item_status, 'open');
  const event = returned.thread.findLast((entry) => entry.type === 'move' && entry.kind === 'reopen');
  assert.deepEqual(event.detail.landingFailure, expected);

  const historical = `test/a.test.js: "first; test/b.test.js: second"; merge commit ${'c'.repeat(40)}`;
  const legacyReplica = openBoard(':memory:');
  try {
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
  }
  finally { store.closeBoard(legacyReplica); }

  const legacyRefusalReplica = openBoard(':memory:');
  try {
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
  }
  finally { store.closeBoard(legacyRefusalReplica); }

  const unquotedWorktree = join(box.dir, 'unquoted-web');
  const unquotedItem = await submitLandingFixture(box, 62, 'export const status = "PASS_UNQUOTED";\n', unquotedWorktree);
  await acceptLandingFixture(box, unquotedItem);
  const unquotedNote = `review context: web/landing.test.js: keeps the landed behavior; merge commit ${'c'.repeat(40)}`;
  const unquotedReopen = await reopenCommand(box, box.repo, String(unquotedItem.id), '--note', unquotedNote, '--json');
  assert.equal(unquotedReopen.code, 0, [unquotedReopen.err, unquotedReopen.out].filter(Boolean).join('\n'));
  assert.deepEqual(JSON.parse(unquotedReopen.out).landingFailure.tests,
    [{ file: 'web/landing.test.js', name: 'keeps the landed behavior' }],
    'the current CLI preserves unquoted evidence found after prose');
});

test('clause 2: a red landing gate returns a verified item to its builder [B3,V4]', async (t) => {
  const box = landingProject();
  const item = await submitLandingFixture(box, 1, 'export const status = "RED";\n');
  await acceptLandingFixture(box, item);
  const initial = readItem(box, item.id);
  const originalAccept = initial.thread.find((event) => event.type === 'move' && event.kind === 'accept');
  assert.ok(originalAccept, 'the item begins with an actual accept event');
  requireLandingBehavior(box);

  const nonCoordinator = await reopenCommand(box, item.cwd, String(item.id), '--note', 'coordinator only', '--json');
  assert.equal(JSON.parse(nonCoordinator.out).error.code, 'COORDINATOR_ONLY');

  const landing = (await fixtureCommand(box, box.repo, 'land', '--max', '1', '--json'));
  // land exits 1 when nothing lands and every candidate is a culprit (d8505b797a).
  assert.equal(landing.code, 1, `${landing.err}\n${landing.out}`);
  const landingResult = JSON.parse(landing.out);
  assert.deepEqual(landingResult.culprits.map((culprit) => culprit.id), [item.id], JSON.stringify(landingResult));
  assert.equal(landingResult.culprits[0].mergeCommit, landingResult.batch.tip);
  assert.equal(landingResult.culprits[0].tests[0].file, 'web/landing.test.js');
  const returned = readItem(box, item.id);
  assert.equal(returned.item_status, 'open', 'land reopens its named culprit automatically');
  const automaticReopen = returned.thread.find((event) => event.type === 'move' && event.kind === 'reopen');
  assert.ok(automaticReopen);
  assert.equal(automaticReopen.detail.supersedes, originalAccept.eventId);
  assert.equal(automaticReopen.detail.landingFailure.mergeCommit, landingResult.batch.tip);
  assert.deepEqual(automaticReopen.detail.landingFailure.tests, landingResult.culprits[0].tests);
  assert.ok(returned.thread.some((event) => event.type === 'move' && event.eventId === originalAccept.eventId && event.kind === 'accept'),
    'the original accept remains in append-only item history');
  assert.deepEqual(returned.thread.find((event) => event.eventId === originalAccept.eventId), originalAccept,
    'returning the item does not rewrite its earlier accept event');
  assert.deepEqual(returned.verdicts, initial.verdicts, 'the prior verdict receipt stays byte-for-byte unchanged');
  const landingNote = automaticReopen.detail.note;

  const firstClaim = (await fixtureCommand(box, item.cwd, 'claim', String(item.id)));
  assert.equal(firstClaim.code, 0, firstClaim.err);
  // A resubmit with no diff against main is EMPTY_SUBMIT before any proof; carry a real change so the red gate decides.
  const stillRed = commitFile(box, item.cwd, 'web/feature.js', 'export const status = "RED"; // unchanged behavior\n', 'fix(web): retry without fixing the landing behavior [G1]');
  assert.equal(stillRed.status, 0, stillRed.stderr);
  const unchangedLandingHead = (await fixtureCommand(box, item.cwd, 'submit', String(item.id), '--json'));
  assert.equal(unchangedLandingHead.code, 1);
  const reclaimedHead = box.git(item.cwd, 'rev-parse', 'HEAD');
  assert.equal(JSON.parse(unchangedLandingHead.out).error.code, reclaimedHead === item.commit ? 'HEAD_NOT_NEW' : 'GATE_RED',
    'the original head is refused before proof; a claim that merged main still fails the unchanged red behavior');
  assert.equal(readItem(box, item.id).item_status, 'claimed', 'neither refusal records another submission');
  assert.equal(box.tryGit(item.cwd, 'merge-base', '--is-ancestor', item.commit, 'HEAD').status, 0,
    'the builder reclaims on top of the accepted commit');
  const firstFix = commitFile(box, item.cwd, 'web/feature.js', 'export const status = "PASS_FIXED";\n', 'fix(web): restore landing behavior [G1]');
  assert.equal(firstFix.status, 0, firstFix.stderr);
  item.commit = box.git(item.cwd, 'rev-parse', 'HEAD');
  const firstSubmit = (await fixtureCommand(box, item.cwd, 'submit', String(item.id)));
  assert.equal(firstSubmit.code, 0, firstSubmit.err);
  const awaitingFreshAccept = readItem(box, item.id);
  assert.equal(awaitingFreshAccept.item_status, 'submitted');
  assert.equal(awaitingFreshAccept.item_verified_by, null, 'the older accept does not verify the resubmission');
  const firstDryLand = (await fixtureCommand(box, box.repo, 'land', '--dry-run', '--json'));
  assert.equal(firstDryLand.code, 0, firstDryLand.err);
  assert.ok(!JSON.parse(firstDryLand.out).items.includes(item.id), 'the earlier accept cannot make the resubmission eligible to land');
  await acceptLandingFixture(box, item);
  const firstResubmission = readItem(box, item.id);
  const firstFreshAccept = firstResubmission.thread.filter((event) => event.type === 'move' && event.kind === 'accept').at(-1);
  assert.notEqual(firstFreshAccept.detail.commit, originalAccept.detail.commit);

  await assertLegacyVerifiedReopen(t, box, item, landingNote);
  const manualBox = landingProject();
  const manualItem = await submitLandingFixture(manualBox, 1, 'export const status = "PASS_MANUAL";\n');
  await acceptLandingFixture(manualBox, manualItem);
  const manualBoard = openBoard(join(manualBox.repo, '.git', 'pullboard', 'board.sqlite'));
  let manualSnapshot;
  try {
    assert.deepEqual(store.landingBatches(manualBoard), [], 'hand-run landing evidence starts with no recorded batch');
    manualSnapshot = exportBoard(manualBoard);
  }
  finally { store.closeBoard(manualBoard); }
  const manualAccept = readItem(manualBox, manualItem.id).thread.find((event) => event.type === 'move' && event.kind === 'accept');
  const generatedBoard = openBoard(':memory:');
  importBoard(generatedBoard, manualSnapshot);
  t.after(() => store.closeBoard(generatedBoard));
  const generatedNote = `Landing batch fixture_batch-1 failed web/landing.test.js: first red; nested/roadmap.test.js: second red; merge commit ${'f'.repeat(40)}`;
  const generatedReopen = store.reopen(generatedBoard, manualItem.id, { agentId: 'coordinator', note: generatedNote });
  assert.equal(store.getItem(generatedBoard, manualItem.id).item_status, 'open');
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
  const noNamedTest = await reopenCommand(manualBox, manualBox.repo, String(manualItem.id), '--note', `merge commit ${'d'.repeat(40)}`, '--json');
  assert.equal(noNamedTest.code, 1);
  assert.equal(JSON.parse(noNamedTest.out).error.code, 'LANDING_FAILURE_REQUIRED');
  for (const invalidNote of [
    `Landing failed: gate red; merge commit ${'d'.repeat(40)}`,
    `Landing gate red on the runner: see the log; merge commit ${'d'.repeat(40)}`,
    `Reopening #12: the gate was red; merge commit ${'d'.repeat(40)}`,
  ]) {
    const refused = await reopenCommand(manualBox, manualBox.repo, String(manualItem.id), '--note', invalidNote, '--json');
    assert.equal(refused.code, 1, invalidNote);
    assert.equal(JSON.parse(refused.out).error.code, 'LANDING_FAILURE_REQUIRED', invalidNote);
    assert.equal(readItem(manualBox, manualItem.id).item_status, 'verified', 'a malformed manual note leaves the item verified');
  }
  assert.match(JSON.parse(noNamedTest.out).error.message,
    /<test file>: <test name>; merge commit <sha>/u, 'the refusal explains the exact manual evidence format');
  const manualNote = `web/landing.test.js: keeps the landed behavior; merge commit ${'d'.repeat(40)}`;
  const manual = await reopenCommand(manualBox, manualBox.repo, String(manualItem.id), '--note', manualNote, '--json');
  assert.equal(manual.code, 0, manual.err);
  const manuallyReturned = readItem(manualBox, manualItem.id);
  assert.equal(manuallyReturned.item_status, 'open');
  const manualEvent = manuallyReturned.thread.filter((event) => event.type === 'move' && event.kind === 'reopen').at(-1);
  assert.equal(manualEvent.detail.supersedes, manualAccept.eventId);
  assert.deepEqual(manualEvent.detail.landingFailure, {
    batch: null,
    tests: [{ file: 'web/landing.test.js', name: 'keeps the landed behavior' }],
    mergeCommit: 'd'.repeat(40),
  });
  assert.ok(manuallyReturned.thread.some((event) => event.eventId === manualAccept.eventId && event.kind === 'accept'),
    'the prior manual accept remains immutable in history');

  const nextManualNote = `web/landing.test.js: keeps the landed behavior; merge commit ${'e'.repeat(40)}`;
  const returnedAgain = await reopenCommand(box, box.repo, String(item.id), '--note', nextManualNote, '--json');
  assert.equal(returnedAgain.code, 0, returnedAgain.err);
  const returnedAgainItem = readItem(box, item.id);
  const returnedAgainEvent = returnedAgainItem.thread.filter((event) => event.type === 'move' && event.kind === 'reopen').at(-1);
  assert.equal(returnedAgainEvent.detail.supersedes, firstFreshAccept.eventId);
  assert.equal(returnedAgainEvent.detail.landingFailure.batch, null);

  const secondClaim = (await fixtureCommand(box, item.cwd, 'claim', String(item.id)));
  assert.equal(secondClaim.code, 0, secondClaim.err);
  const secondFix = commitFile(box, item.cwd, 'web/feature.js', 'export const status = "PASS_AGAIN";\n', 'fix(web): finish landing rework [G1]');
  assert.equal(secondFix.status, 0, secondFix.stderr);
  item.commit = box.git(item.cwd, 'rev-parse', 'HEAD');
  const secondSubmit = (await fixtureCommand(box, item.cwd, 'submit', String(item.id)));
  assert.equal(secondSubmit.code, 0, secondSubmit.err);
  const secondAwaitingAccept = readItem(box, item.id);
  assert.equal(secondAwaitingAccept.item_status, 'submitted');
  assert.equal(secondAwaitingAccept.item_verified_by, null, 'the prior accepts do not verify the second resubmission');
  const secondDryLand = (await fixtureCommand(box, box.repo, 'land', '--dry-run', '--json'));
  assert.equal(secondDryLand.code, 0, secondDryLand.err);
  assert.ok(!JSON.parse(secondDryLand.out).items.includes(item.id), 'the earlier accepts cannot make the second resubmission eligible to land');
  await acceptLandingFixture(box, item);
  const readyToLand = readItem(box, item.id);
  assert.equal(readyToLand.thread.filter((event) => event.type === 'move' && event.kind === 'accept').length, 3,
    'the resubmitted work has a fresh accept');
  assert.equal(JSON.parse((await fixtureCommand(box, item.cwd, 'reopen', String(item.id), '--note', landingNote, '--json')).out).error.code, 'COORDINATOR_ONLY');

  const greenLanding = (await fixtureCommand(box, box.repo, 'land', '--max', '1', '--json'));
  assert.equal(greenLanding.code, 0, greenLanding.err);
  assert.deepEqual(JSON.parse(greenLanding.out).landed, [item.id]);
  const merged = readItem(box, item.id);
  assert.equal(merged.item_status, 'verified');
  assert.ok(merged.item_merged_commit);
  const mergedReopen = await reopenCommand(box, box.repo, String(item.id), '--note', landingNote, '--json');
  assert.equal(mergedReopen.code, 1);
  assert.equal(JSON.parse(mergedReopen.out).error.code, 'ALREADY_MERGED');
});

test('manual reopen accepts a failing root-level test after an unrecorded two-parent merge [B3,V4]', async (t) => {
  const box = landingProject();
  const item = await submitLandingFixture(box, 1, 'export const status = "RED";\n');
  await acceptLandingFixture(box, item);

  writeFileSync(join(box.repo, 'root.test.js'), [
    "import assert from 'node:assert/strict';",
    "import { readFileSync } from 'node:fs';",
    "import { test } from 'node:test';",
    "test('root-level landing behavior remains green', () => assert.match(readFileSync(new URL('./web/feature.js', import.meta.url), 'utf8'), /export const status = [\"']PASS[\"']/u));",
    '',
  ].join('\n'));
  box.git(box.repo, 'add', 'root.test.js');
  box.git(box.repo, 'commit', '-q', '-m', 'test: guard root-level landing behavior [G1]');

  const merged = box.tryGit(box.repo, 'merge', '--no-ff', '--no-edit', item.commit);
  assert.equal(merged.status, 0, merged.failure ?? merged.stderr);
  const mergeCommit = box.git(box.repo, 'rev-parse', 'HEAD');
  const mergeParents = box.git(box.repo, 'rev-list', '--parents', '-n', '1', mergeCommit).split(' ');
  assert.equal(mergeParents.length, 3, 'the manual landing evidence names a real two-parent merge commit');
  assert.equal(mergeParents[2], item.commit, 'the second parent is the accepted item commit');

  const failingRootTest = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'root.test.js'], {
    cwd: box.repo, env: box.env, encoding: 'utf8',
  });
  assert.equal(failingRootTest.status, 1, failingRootTest.stderr || failingRootTest.stdout);
  assert.match(failingRootTest.stdout, /not ok 1 - root-level landing behavior remains green/u);

  const board = openFixtureBoard(t, box);
  assert.deepEqual(store.landingBatches(board), [], 'a hand-run merge has no recorded landing batch');
  const accepted = readItem(box, item.id).thread.findLast((event) => event.type === 'move' && event.kind === 'accept');
  assert.ok(accepted, 'the item has the original accept that the landing failure supersedes');
  const note = `root.test.js: root-level landing behavior remains green; merge commit ${mergeCommit}`;
  const reopened = await reopenCommand(box, box.repo, String(item.id), '--note', note, '--json');
  assert.equal(reopened.code, 0, [reopened.err, reopened.out].filter(Boolean).join('\n'));
  assert.deepEqual(JSON.parse(reopened.out).landingFailure, {
    batch: null,
    tests: [{ file: 'root.test.js', name: 'root-level landing behavior remains green' }],
    mergeCommit,
  });

  const returned = readItem(box, item.id);
  assert.equal(returned.item_status, 'open');
  assert.equal(returned.item_commit, item.commit, 'the accepted commit remains recorded');
  const reopenEvent = returned.thread.findLast((event) => event.type === 'move' && event.kind === 'reopen');
  assert.equal(reopenEvent.detail.supersedes, accepted.eventId);
  assert.deepEqual(reopenEvent.detail.landingFailure, JSON.parse(reopened.out).landingFailure);
  assert.ok(returned.thread.some((event) => event.eventId === accepted.eventId && event.kind === 'accept'),
    'the append-only accept remains in history');
});

test('manual reopen records a timestamp-prefixed failing test after an unrecorded two-parent merge [B3,V4]', async (t) => {
  const box = landingProject();
  const item = await submitLandingFixture(box, 1, 'export const status = "RED";\n');
  await acceptLandingFixture(box, item);

  mkdirSync(join(box.repo, 'test'), { recursive: true });
  writeFileSync(join(box.repo, 'test/a.test.js'), [
    "import assert from 'node:assert/strict';",
    "import { readFileSync } from 'node:fs';",
    "import { test } from 'node:test';",
    "test('keeps it', () => assert.match(readFileSync(new URL('../web/feature.js', import.meta.url), 'utf8'), /export const status = [\"']PASS[\"']/u));",
    '',
  ].join('\n'));
  box.git(box.repo, 'add', 'test/a.test.js');
  box.git(box.repo, 'commit', '-q', '-m', 'test: keep the released landing behavior [G1]');

  const merged = box.tryGit(box.repo, 'merge', '--no-ff', '--no-edit', item.commit);
  assert.equal(merged.status, 0, merged.failure ?? merged.stderr);
  const mergeCommit = box.git(box.repo, 'rev-parse', 'HEAD');
  const mergeParents = box.git(box.repo, 'rev-list', '--parents', '-n', '1', mergeCommit).split(' ');
  assert.equal(mergeParents.length, 3, 'the valid contextual note names an actual two-parent merge');
  assert.equal(mergeParents[2], item.commit, 'the accepted item is the second parent');

  const failingTest = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test/a.test.js'], {
    cwd: box.repo, env: box.env, encoding: 'utf8',
  });
  assert.equal(failingTest.status, 1, failingTest.stderr || failingTest.stdout);
  assert.match(failingTest.stdout, /not ok 1 - keeps it/u);

  const board = openFixtureBoard(t, box);
  assert.deepEqual(store.landingBatches(board), [], 'a hand-run merge has no recorded landing batch');
  const accepted = readItem(box, item.id).thread.findLast((event) => event.type === 'move' && event.kind === 'accept');
  assert.ok(accepted, 'the verified item keeps its original accept');
  const note = `Gate red at 10:30, test/a.test.js: keeps it; merge commit ${mergeCommit}`;
  const reopened = await reopenCommand(box, box.repo, String(item.id), '--note', note, '--json');
  assert.equal(reopened.code, 0, [reopened.err, reopened.out].filter(Boolean).join('\n'));
  const landingFailure = {
    batch: null,
    tests: [{ file: 'test/a.test.js', name: 'keeps it' }],
    mergeCommit,
  };
  assert.deepEqual(JSON.parse(reopened.out).landingFailure, landingFailure);
  const returned = readItem(box, item.id);
  assert.equal(returned.item_status, 'open');
  const reopenEvent = returned.thread.findLast((event) => event.type === 'move' && event.kind === 'reopen');
  assert.equal(reopenEvent.detail.supersedes, accepted.eventId);
  assert.deepEqual(reopenEvent.detail.landingFailure, landingFailure);
  assert.ok(returned.thread.some((event) => event.eventId === accepted.eventId && event.kind === 'accept'),
    'the append-only accept remains in history');
});

test('a reopened bar takes the same commit again [V2,V6,H16]', async (t) => {
  let engine10Store, engine10Exchange;
  const box = project();
  const submitted = await submitFixture(box);
  const reviewPath = await reserveFixtureReview(box);
  const copies = replicaPair(t, box);
  assert.ok(ENGINE_VERSION >= 8, 'engine 8 introduces ordered reopen semantics');
  assert.ok(ENGINE_VERSION >= 10, 'engine 10 adds verified-item landing reopens');
  const move = prepareEngineMove(copies[0], 'reopen', [1, {
    agentId: 'coordinator', note: 'replay the no-verdict return',
  }], { id: 'reopen-engine-roundtrip', actor: 'coordinator' });
  assert.equal(move.engine, ENGINE_VERSION, "new moves use the current engine while legacy receipts retain their recorded engine");
  const oldReceiver = openBoard(join(box.dir, 'old-engine.sqlite'));
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
    const legacyReceiver = legacyStore.openBoard(join(box.dir, `engine-${version}-reopen.sqlite`));
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
    const currentLegacyReceiver = openBoard(join(box.dir, `current-engine-${version}-reopen.sqlite`));
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

  const reopened = await reopenCommand(box, box.repo, '1', '--note', 'correct the frozen criterion');
  assert.equal(reopened.code, 0, reopened.err);
  const claimedBeforeCorrection = (await fixtureCommand(box, box.web, 'claim', '1'));
  assert.equal(claimedBeforeCorrection.code, 0, claimedBeforeCorrection.err);
  const unchangedBar = (await fixtureCommand(box, box.web, 'submit', '1', '--json'));
  assert.equal(unchangedBar.code, 1);
  assert.equal(JSON.parse(unchangedBar.out).error.code, 'HEAD_NOT_NEW', 'a no-verdict reopen alone does not make the old bar a new submission');
  const released = (await fixtureCommand(box, box.web, 'release', '1', '--reason', 'BLOCKED'));
  assert.equal(released.code, 0, released.err);
  const explicitRefreeze = (await fixtureCommand(box, box.repo, 'refreeze', '1'));
  assert.equal(explicitRefreeze.code, 0, explicitRefreeze.err);
  const claimedAfterRefreeze = (await fixtureCommand(box, box.web, 'claim', '1'));
  assert.equal(claimedAfterRefreeze.code, 0, claimedAfterRefreeze.err);
  const sameContentResubmission = (await fixtureCommand(box, box.web, 'submit', '1', '--json'));
  assert.equal(sameContentResubmission.code, 0, sameContentResubmission.err);
  assert.equal(JSON.parse(sameContentResubmission.out).commit, submitted.commit,
    'an explicit coordinator refreeze is a new frozen bar even when its text is unchanged');

  const secondReopen = await reopenCommand(box, box.repo, '1', '--note', 'correct the frozen criterion to match the implemented heading');
  assert.equal(secondReopen.code, 0, secondReopen.err);
  const edited = (await fixtureCommand(box, box.repo, 'edit', '1', '--criterion', 'The page renders a heading.', '--reason', 'the fixture corrects its bar'));
  assert.equal(edited.code, 0, edited.err);
  const correctedHistory = openFixtureBoard(t, box);
  assert.equal(correctedNoVerdictReopen(correctedHistory, 1, submitted.commit), false,
    'an atomic correction alone cannot replace the matching post-correction claim');

  const claimed = (await fixtureCommand(box, box.web, 'claim', '1'));
  assert.equal(claimed.code, 0, claimed.err);
  assert.equal(correctedNoVerdictReopen(correctedHistory, 1, submitted.commit), true,
    'the real new claim binds the canonical corrected frozen bar');
  assert.equal(correctedNoVerdictReopen(correctedHistory, 1, '0'.repeat(40)), false,
    'the correction never authorizes a different previous submission');
  const claimedBoard = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  claimedBoard.gitRoot = box.repo;
  let claimedBoardOpen = true;
  t.after(() => { if (claimedBoardOpen) store.closeBoard(claimedBoard); });
  // Model the historical proofless wire explicitly; modern preparation adds later clause-policy fields.
  const engine11Move = { version: 1, engine: 11, id: 'same-commit-engine-11', operation: 'submit', actor: 'web-1',
    args: [1, { agentId: 'web-1', commit: submitted.commit, tree: submitted.tree,
      policyCommit: box.git(box.repo, 'rev-parse', 'HEAD') }] };
  const builderSender = { kind: 'agent', userId: 'fixture-user', agent: 'web-1' };
  const engine10Replica = openBoard(join(box.dir, 'engine-10-same-commit.sqlite'));
  t.after(() => store.closeBoard(engine10Replica));
  const engine10Move = { ...engine11Move, id: 'same-commit-engine-10', engine: 10 };
  const markedReplica = openBoard(join(box.dir, 'modern-grant-same-commit.sqlite'));
  t.after(() => store.closeBoard(markedReplica));
  importBoard(markedReplica, exportBoard(claimedBoard));
  assert.equal(agentGrantMinimum(markedReplica, engine10Move), AGENT_GRANT_ENGINE, 'the current claim retains its exact grant-engine floor');
  assert.throws(() => applyRelayMove(markedReplica, engine10Move, {
    sequence: 1, at: '2026-10-10T12:00:02.000Z', kind: 'move', sender: builderSender,
  }), error => error.code === 'RELAY_MOVE' && Number(/use engine (\d+) or newer/u.exec(error.message)?.[1]) >= AGENT_GRANT_ENGINE,
  'an engine-10 move cannot interpret the current grant or any later active policy');

  // Seed the historical lifecycle with the actual released engine-10 writer, not by deleting modern markers.
  // These are board-state fixtures only: neither direct submit call claims an executed gate.
  const legacySeed = engine10Store.openBoard(join(box.dir, 'actual-engine10-submit-state.sqlite'));
  t.after(() => engine10Store.closeBoard(legacySeed));
  engine10Store.register(legacySeed, { lane: 'coordinator', path: box.repo });
  const legacyBuilder = engine10Store.register(legacySeed, { lane: 'web', path: box.web });
  const initialItem = store.getItem(copies[0], 1), correctedItem = store.getItem(claimedBoard, 1);
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
  store.closeBoard(claimedBoard);
  claimedBoardOpen = false;

  const resubmission = (await fixtureCommand(box, box.web, 'submit', '1', '--json'));
  let resubmissionDiagnostic = resubmission.err;
  if (resubmission.code !== 0) {
    let refusal;
    try { refusal = JSON.parse(resubmission.out).error; }
    catch { refusal = { code: 'UNREADABLE_NATIVE_ERROR', message: 'native failure JSON was unreadable' }; }
    resubmissionDiagnostic = safeFixtureDiagnostic(
      `${refusal?.code ?? 'UNKNOWN'}: ${refusal?.message ?? ''}\n${resubmission.err}`, box.env);
  }
  assert.equal(resubmission.code, 0, resubmissionDiagnostic);
  assert.equal(JSON.parse(resubmission.out).commit, submitted.commit, 'the corrected bar accepts the original commit without inventing an empty commit');
  const board = openFixtureBoard(t, box);
  assert.equal(store.getItem(board, 1).item_commit, submitted.commit);
  const review = (await fixtureCommand(box, reviewPath, 'next', '--verify', '1'));
  assert.equal(review.code, 0, review.err);
  box.git(reviewPath, 'merge', '--ff-only', submitted.commit);
  const rejected = (await fixtureCommand(box, reviewPath, 'verify', '1', 'reject', '--reason', 'BEHAVIOR_MISMATCH', '--clause', 'The page renders a heading.', '--note', 'the corrected criterion still fails'));
  assert.equal(rejected.code, 0, rejected.err);
  const reclaimed = (await fixtureCommand(box, box.web, 'claim', '1'));
  assert.equal(reclaimed.code, 0, reclaimed.err);
  const sameRejectedHead = (await fixtureCommand(box, box.web, 'submit', '1', '--json'));
  assert.equal(sameRejectedHead.code, 1);
  assert.equal(JSON.parse(sameRejectedHead.out).error.code, 'HEAD_NOT_NEW', 'a rejection at the current corrected digest still blocks the same commit');
  assert.equal(store.getItem(board, 1).item_status, 'claimed');
  assert.equal(store.getItem(board, 1).item_verdict, 'REJECT');
});

test('clause 3: retained main controls builder first refusal during detached review [B13,B5,H16]', async t => {
  const box = project();
  /** Await real production commands; fixture moves do not start an unrelated next-work search. */
  const command = (cwd, ...args) => runCliInProcess(args, { cwd, env: box.env });
  const added = await command(box.repo, 'add', 'web', 'Corrected criterion', '--specs', 'G1', '--criterion', 'The page renders.', '--route', 'strong', '--wait');
  assert.equal(added.code, 0, added.err);
  const claimedFirst = await command(box.web, 'claim', '1');
  assert.equal(claimedFirst.code, 0, claimedFirst.err);
  const built = commitFile(box, box.web, 'web/page.html', '<h1>Page</h1>', 'feat(web): page [G1]');
  assert.equal(built.status, 0, built.stderr);
  const submitted = await command(box.web, 'submit', '1', '--wait', '--no-next');
  assert.equal(submitted.code, 0, submitted.err);
  const commit = box.git(box.web, 'rev-parse', 'HEAD');
  const configPath = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.claim = { reopenFirstRefusalMinutes: 30 };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: enable the private builder window');
  const main = box.git(box.repo, 'rev-parse', 'HEAD');
  assert.equal(JSON.parse(box.git(box.web, 'show', 'HEAD:pullboard.json')).claim, undefined,
    'the candidate does not carry the enabled setting');
  box.git(box.repo, 'switch', '-q', '--detach', commit);
  try {
    const accepted = await command(box.repo, 'verify', '1', 'accept', '--no-next', '--as', 'coordinator', '--note', 'the private frozen check passed');
    assert.equal(accepted.code, 0, accepted.err + accepted.out);
  } finally { box.git(box.repo, 'switch', '-q', 'main'); }
  const withdrawn = await command(box.repo, 'reopen', '1', '--withdraw-verdict', '--note', 'the private proof requires rework', '--json');
  assert.equal(withdrawn.code, 0, withdrawn.err + withdrawn.out);
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD'), main);
  const other = join(box.dir, 'web-other');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', other, 'main');
  assert.equal((await command(other, 'join', 'web', '--model', 'Other private builder', '--route', 'strong')).code, 0);
  const refused = await command(other, 'claim', '1', '--json');
  assert.equal(refused.code, 1, refused.out);
  const error = JSON.parse(refused.out).error;
  assert.equal(error.code, 'REOPEN_HELD_FOR_BUILDER');
  assert.match(error.message, /web-1/u);
  const board = openFixtureBoard(t, box);
  const returned = store.events(board, { itemId: 1 }).findLast(event => event.event_kind === 'reopen');
  const window = JSON.parse(returned.event_detail).reopenFirstRefusal;
  assert.equal(window.builder, 'web-1');
  assert.equal(Date.parse(window.until) - Date.parse(returned.event_at), 30 * 60_000);
  assert.equal(store.recentShouts(board).filter(row => row.shout_to === 'web-1' && row.shout_text.includes('waits for you')).length, 1);
  // #2779 removed the first-refusal window a reject sealed; this clause covers the withdrawal path (#2460), where the claim opens only once the window has passed.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(29 * 60_000);
  // #3447: a builder silent for two minutes is gone and its window ends at once, so the live builder beats before each claim.
  store.heartbeatSeat(board, 'web-1');
  const insideWindow = await command(other, 'claim', '1', '--json');
  assert.equal(insideWindow.code, 1, insideWindow.out);
  assert.equal(JSON.parse(insideWindow.out).error.code, 'REOPEN_HELD_FOR_BUILDER', 'still inside the 30-minute window');
  t.mock.timers.tick(2 * 60_000);
  store.heartbeatSeat(board, 'web-1');
  const claimed = await command(other, 'claim', '1');
  assert.equal(claimed.code, 0, claimed.err);
});


/** Give an accepted private item a real reviewer and an enabled builder-return window. */
async function withdrawalFixture(t) {
  const box = project();
  const file = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.claim = { reopenFirstRefusalMinutes: 30 };
  writeFileSync(file, JSON.stringify(config));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: enable private builder return window');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const submitted = await submitFixture(box);
  const reviewer = await reserveFixtureReview(box);
  box.git(reviewer, 'switch', '-q', '--detach', submitted.commit);
  const accepted = (await fixtureCommand(box, reviewer, 'verify', '1', 'accept', '--note', 'the private frozen check passed', '--json'));
  assert.equal(accepted.code, 0, accepted.err + accepted.out);
  const board = openFixtureBoard(t, box);
  const original = board.db.prepare('SELECT * FROM verdict WHERE item_id = ?').get(1);
  return { box, reviewer, board, original, submitted };
}

test('a reviewer withdraws its own accept before landing and the builder gets the item back [V2,V6,H16]', async t => {
  for (const coordinator of [false, true]) {
    const { box, reviewer, board, original, submitted } = await withdrawalFixture(t);
    const initial = store.itemThread(board, 1).find(row => row.kind === 'accept');
    if (coordinator) {
      const stranger = await reopenCommand(box, box.web, '1', '--withdraw-verdict', '--note', 'not my verdict', '--json');
      assert.equal(JSON.parse(stranger.out).error.code, 'VERDICT_WITHDRAW_FORBIDDEN');
      const missing = await reopenCommand(box, box.repo, '1', '--withdraw-verdict', '--note', ' ', '--json');
      assert.equal(JSON.parse(missing.out).error.code, 'NOTE_REQUIRED');
    }
    const result = await reopenCommand(box, coordinator ? box.repo : reviewer, '1', '--withdraw-verdict',
      '--note', 'the accepted interpretation missed a recorded ruling', '--json');
    assert.equal(result.code, 0, result.err + result.out);
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
    const accept = thread.find(row => row.kind === 'accept');
    assert.equal(accept.eventId, initial.eventId);
    assert.deepEqual(accept.detail, initial.detail, 'the recorded acceptance detail is not rewritten');
    assert.equal(accept.withdrawn, true, 'history marks the exact earlier accept withdrawn');
    const move = thread.findLast(row => row.kind === 'reopen');
    assert.equal(move.detail.withdrawnVerdict.verdictId, original.verdict_id);
    assert.equal(move.detail.withdrawnVerdict.acceptEventId, initial.eventId);
    assert.equal(move.detail.reopenFirstRefusal.builder, 'web-1');
    assert.equal(Date.parse(move.detail.reopenFirstRefusal.until) - Date.parse(move.at), 30 * 60_000);
    assert.equal((await fixtureCommand(box, box.web, 'claim', '1')).code, 0, 'the original builder can resume normally');
  }
  const { box, reviewer, submitted } = await withdrawalFixture(t);
  box.git(box.repo, 'merge', '-q', '--no-edit', submitted.commit);
  const merged = (await fixtureCommand(box, box.repo, 'merged', '1', box.git(box.repo, 'rev-parse', 'HEAD'), '--json'));
  assert.equal(merged.code, 0, merged.err + merged.out);
  for (const caller of [box.repo, reviewer]) {
    const refused = await reopenCommand(box, caller, '1', '--withdraw-verdict', '--note', 'too late', '--json');
    assert.equal(JSON.parse(refused.out).error.code, 'ALREADY_MERGED');
  }
});
