import { digestNativePorts } from '../../tests/fixtures/ports.js';
/**
 * pullboard health names every stuck item, why, since when, the next step and who takes it, on a
 * real SQLite board in a real git repo with an injected clock, and never changes either [A6].
 */
import { executionServices } from '../../tests/fixtures/gate/execution.js';
import { dispatchHealth } from '../../../../packages/sentinels/index.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { addMilestone } from '../../../../packages/store/index.js';
import { main } from '../../tests/fixtures/native.js';
import {
  boardHealth,
  healthReport,
} from '../../../../packages/health/index.js';
import {
  fixture as dispatchFixture,
  cli as dispatchCli,
} from '../../tests/fixtures/next/take.js';
import { readDigest } from '../../../../packages/items/index.js';
import { heartbeatSeat } from '../../../../packages/store/index.js';
import { recurringJobs } from '../../../../packages/store/index.js';
import { scanHealthSentinel } from '../../../../packages/sentinels/index.js';
import { loadConfig } from '../../../../packages/config/index.js';
import {
  gateRuns,
  runGate as frontDoorRunGate,
} from '../../../../packages/gate/index.js';
import { JSON_SHAPES } from '../../../../packages/config/index.js';
import {
  runFixtureChild,
  runFixtureGit,
} from '../../tests/fixtures/child.js';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const freeze = (item) => ({ text: item.item_title, digest: `digest:${item.item_title}` });

test('health upper bindings retain actual dispatch findings without changing the observed board [A6,N2,C7]', async t => {
  const box = await dispatchFixture(t);
  box.add('Ready work for a real free fixture seat');
  // Digest intentionally uses the host date; keep this private cohort on that date while advancing its boundary explicitly.
  box.advance(Date.now() - 300000 - box.clock.now().getTime());
  for (const seat of Object.values(box.seats)) heartbeatSeat(box.board, seat.id);
  box.scan();
  box.advance(300000);
  const expected = dispatchHealth(box.board, box.config).findings;
  assert.ok(expected.length > 0, 'the native five-minute dispatch boundary is actually reached');
  const before = store.events(box.board);
  let called = 0;
  const report = healthReport({ db: box.board.db, root: box.root, config: box.config, now: box.clock.now(),
    dispatchHealth(observed, config) {
      called++;
      assert.equal(observed.db, box.board.db, 'the port sees this exact native read snapshot');
      assert.equal(observed.clock.now().getTime(), box.clock.now().getTime());
      assert.equal(config, box.config);
      return dispatchHealth(observed, config);
    } });
  assert.equal(called, 1);
  assert.deepEqual(report.stuck.filter(entry => entry.cause === 'UNPAIRED_WORK'), expected);
  const read = boardHealth(box.file, { root: box.root, config: box.config, now: box.clock.now(), dispatchHealth });
  assert.deepEqual(read.stuck.filter(entry => entry.cause === 'UNPAIRED_WORK'), expected);
  const command = await dispatchCli(box, box.root, ['health']);
  assert.equal(command.code, 1, command.err);
  assert.deepEqual(command.document.stuck.filter(entry => entry.cause === 'UNPAIRED_WORK'), expected);
  const digest = await dispatchCli(box, box.root, ['digest']);
  assert.equal(digest.code, 0, digest.err);
  for (const finding of expected) assert.ok(digest.document.markdown.includes(finding.title), 'the actual digest CLI retains dispatch health');
  assert.doesNotThrow(() => readDigest(box.file, undefined, digestNativePorts), 'a root-free digest still needs no health operation');
  assert.deepEqual(store.events(box.board), before, 'health observation is read-only');
  assert.throws(() => healthReport({ db: box.board.db, root: box.root, config: box.config, now: box.clock.now() }),
    /requires its dispatchHealth observation port/u, 'an omitted port never silently drops findings');
});

/** A private repo, git identity and Pullboard home, so neither git nor the CLI reads this machine. */
function repo(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-health-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo');
  mkdirSync(root);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Health Test', GIT_AUTHOR_EMAIL: 'health@example.com',
    GIT_COMMITTER_NAME: 'Health Test', GIT_COMMITTER_EMAIL: 'health@example.com',
  });
  for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name];
  Object.assign(process.env, { PULLBOARD_HOME: join(dir, 'home'), PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  delete process.env.PULLBOARD_RELAY_TOKEN;
  /** Run git in the fixture repo, optionally at a fixed commit date. */
  const git = (args, date) => runFixtureGit(args, { cwd: root, env: date ? { ...env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } : env });
  git(['init', '-q', '-b', 'main']);
  writeFileSync(join(root, 'pullboard.json'), `${JSON.stringify({ gate: 'true', lanes: { core: { owns: ['src/'] }, docs: { owns: ['docs/'] }, review: { owns: [] } } }, null, 2)}\n`);
  writeFileSync(join(root, 'a.txt'), 'base\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'chore: base'], ago(72 * HOUR));
  return { dir, root, git, file: join(root, '.git', 'pullboard', 'board.sqlite') };
}

/** Commit one file on a new branch from `from`, then return to main; returns the commit. */
function branchCommit(box, branch, from, path, text) {
  box.git(['checkout', '-q', '-b', branch, from]);
  writeFileSync(join(box.root, path), text);
  box.git(['add', path]);
  box.git(['commit', '-q', '-m', `feat: ${branch}`]);
  const commit = box.git(['rev-parse', 'HEAD']);
  box.git(['checkout', '-q', 'main']);
  return commit;
}

/** Open the fixture board with a clock the test turns by hand. */
function boardAt(box) {
  const clock = { at: NOW - 40 * HOUR, now() { return new Date(this.at); } };
  const board = openBoard(box.file, clock);
  /** Move the board's clock to a moment before NOW. */
  const at = (ms) => { clock.at = NOW - ms; };
  return { board, at };
}

/** Run the real CLI in this process with the injected clock; returns its exit code and output. */
async function cli(cwd, argv) {
  let stdout = '';
  let stderr = '';
  const code = await main(argv, {
    cwd, clock: { now: () => new Date(NOW) },
    stdout: { isTTY: false, write: (text) => { stdout += text; } },
    stderr: { write: (text) => { stderr += text; } },
  });
  return { code, stdout, stderr };
}

/** Every board row and the event count, so a read can be proved to change nothing. */
function boardDigest(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = ['item', 'verdict', 'shout', 'event', 'hold', 'agent', 'board_meta'];
    const rows = tables.map((table) => JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()));
    return { events: db.prepare('SELECT COUNT(*) AS n FROM event').get().n, hash: createHash('sha256').update(rows.join('\n')).digest('hex') };
  } finally { db.close(); }
}

/** The checkout's HEAD, index and working tree as git reports them. */
function checkout(box) {
  return { head: box.git(['rev-parse', 'HEAD']), status: box.git(['status', '--porcelain', '--untracked-files=all']),
    index: createHash('sha256').update(readFileSync(join(box.root, '.git', 'index'))).digest('hex') };
}

test('health names each stuck cause with its next step and owner [A6]', async (t) => {
  const box = repo(t);
  const base = box.git(['rev-parse', 'HEAD']);
  box.git(['tag', 'v0.1.0']);
  const conflicting = branchCommit(box, 'core/conflict', base, 'a.txt', 'branch\n');
  const clean = branchCommit(box, 'core/clean', base, 'clean.txt', 'clean\n');
  const cleared = branchCommit(box, 'core/cleared', base, 'other.txt', 'other\n');
  const parent = branchCommit(box, 'core/parent', base, 'parent.txt', 'parent\n');
  const child = branchCommit(box, 'core/child', parent, 'child.txt', 'child\n');
  const landed = branchCommit(box, 'core/landed', base, 'landed.txt', 'landed\n');
  const own = Object.fromEntries(['lapsedReview', 'unreviewed', 'rejected', 'later', 'reopened', 'held'].map((name) => [name, branchCommit(box, `core/${name}`, base, `${name}.txt`, `${name}\n`)]));
  writeFileSync(join(box.root, 'a.txt'), 'main\n');
  box.git(['commit', '-q', '-am', 'feat: main moves on'], ago(48 * HOUR));

  const { board, at } = boardAt(box);
  store.register(board, { lane: 'coordinator', path: box.root });
  const builders = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => store.register(board, { lane: 'core', path: join(box.dir, `core-${n}`) }));
  const reviewer = store.register(board, { lane: 'review', path: join(box.dir, 'review-1') });
  const otherReviewer = store.register(board, { lane: 'review', path: join(box.dir, 'review-2') });
  const add = (title, extra = {}) => store.addItem(board, { by: 'coordinator', lane: 'core', title, ...extra });
  const claim = (id, agentId, leaseMs = 2 * HOUR) => store.claim(board, id, { agentId, lane: 'core', leaseMs, freeze });
  const submit = (id, agentId, commit) => submitFixture(board, id, { agentId, commit, tree: `tree-${id}` });
  const decide = (id, decision, commit, title, by = reviewer) => store.verify(board, id, { agentId: by, decision,
    reason: decision === 'ACCEPT' ? 'CRITERION_MET' : 'TEST_FAILURE', note: 'checked the fixture', head: commit, digest: `digest:${title}`, policy: 'any',
    ...(decision === 'REJECT' ? { clause: title } : {}) });
  /** Build an item through claim and submit, optionally to an accept or a reject. */
  const built = (title, agentId, commit, verdict, extra) => {
    const id = add(title, extra);
    claim(id, agentId);
    submit(id, agentId, commit);
    if (verdict) decide(id, verdict, commit, title);
    return id;
  };

  at(30 * HOUR);
  store.holdLane(board, 'docs', { agentId: 'coordinator', reason: 'docs wait for the release notes' });
  const staleHold = add('Stale hold');
  store.holdItem(board, staleHold, { agentId: 'coordinator', reason: 'waiting for the design' });
  at(3 * HOUR);
  const lapsed = add('Lapsed claim');
  claim(lapsed, builders[0], HOUR);
  const reviewLapsed = add('Lapsed review');
  claim(reviewLapsed, builders[1]);
  submit(reviewLapsed, builders[1], own.lapsedReview);
  at(2.5 * HOUR);
  store.reserveReview(board, reviewLapsed, { agentId: reviewer, leaseMs: HOUR / 2, policy: 'any' });
  at(2 * HOUR);
  const unreviewed = built('Waiting review', builders[2], own.unreviewed);
  const conflict = built('Conflicting accept', builders[3], conflicting, 'ACCEPT');
  const ready = built('Clean accept', builders[4], clean, 'ACCEPT');
  const rejected = built('Rejected rework', builders[5], own.rejected, 'REJECT');
  const later = built('Later rework', builders[6], own.later, 'REJECT');
  const reopened = built('Reopened rework', builders[7], own.reopened);
  store.reopen(board, reopened, { agentId: 'coordinator', note: 'the bar named the wrong file' });
  const stacked = built('Stacked accept', builders[8], child, 'ACCEPT');
  const shipped = built('Landed work', builders[9], landed, 'ACCEPT');
  store.merged(board, shipped, { agentId: 'coordinator', commit: landed });
  const heldAccept = add('Held accept');
  claim(heldAccept, builders[10]);
  store.holdItem(board, heldAccept, { agentId: 'coordinator', reason: 'waiting for the person to pick the wording' });
  submit(heldAccept, builders[10], own.held);
  decide(heldAccept, 'ACCEPT', own.held, 'Held accept', otherReviewer);
  const withdrawn = add('Dropped dependency');
  const orphan = add('Orphaned follow-up', { after: [withdrawn] });
  store.withdraw(board, withdrawn, { agentId: 'coordinator', reason: 'superseded by the new layout' });
  const ask = store.shout(board, { from: builders[2], to: 'coordinator', text: 'Which file owns the wording?', lanes: ['core', 'docs', 'review'], decision: true });
  at(HOUR / 6);
  const conflictHold = built('Conflict hold', builders[0], cleared, 'REJECT');
  store.holdItem(board, conflictHold, { agentId: 'coordinator', reason: 'conflicts with the a.txt batch' });
  at(HOUR / 20); // under review.starveMinutes (5): a review that just started is moving, not starved
  const parentItem = built('Parent in review', builders[11], parent);
  addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: '0.1.1', items: [lapsed, rejected, reopened] });
  addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: '0.1.2', items: [later] });
  store.closeBoard(board); // Health opens its own read-only connection.

  const beforeBoard = boardDigest(box.file);
  const beforeCheckout = checkout(box);
  const result = await cli(box.root, ['health', '--json']);
  assert.equal(result.code, 1, `a stuck board exits 1: ${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(boardDigest(box.file), beforeBoard, 'health changes no board row and appends no event');
  assert.deepEqual(checkout(box), beforeCheckout, 'the merge check never touches the HEAD, index or working tree');
  for (const field of Object.keys(JSON_SHAPES.commands.health.required)) assert.ok(field in report, `health JSON has ${field}`);
  assert.equal(report.asOf, new Date(NOW).toISOString(), 'health reads the injected clock');
  assert.deepEqual(report.thresholds, { stuck: '1h', holds: '1d', release: '1d' });

  const byKey = new Map(report.stuck.map((entry) => [entry.key, entry]));
  /** Assert one finding's cause, since, owner and next step, and that its why names `why`. */
  const expect = (key, { cause, since, role, who, next, why }) => {
    const entry = byKey.get(key) ?? report.waiting.find((waiting) => waiting.key === key);
    assert.ok(entry, `health lists ${key}; found ${[...byKey.keys()].join(', ')}`);
    assert.equal(entry.cause, cause, key);
    assert.equal(entry.since, since, `${key} since`);
    assert.deepEqual(entry.owner, { role, who }, `${key} owner`);
    assert.ok(entry.next.includes(next), `${key} next step: ${entry.next}`);
    for (const part of [why].flat()) assert.ok(entry.why.includes(part), `${key} why names ${part}: ${entry.why}`);
    for (const field of ['subject', 'title', 'ageMinutes', 'command', 'detail']) assert.ok(field in entry, `${key} has ${field}`);
    return entry;
  };
  expect(`CLAIM_LAPSED:item:${lapsed}`, { cause: 'CLAIM_LAPSED', since: ago(2 * HOUR), role: 'builder', who: builders[0], next: `pullboard claim ${lapsed}`, why: builders[0] });
  expect(`REVIEW_LAPSED:item:${reviewLapsed}`, { cause: 'REVIEW_LAPSED', since: ago(2 * HOUR), role: 'reviewer', who: null, next: `pullboard next --verify ${reviewLapsed}`, why: reviewer });
  expect(`NO_REVIEWER:item:${unreviewed}`, { cause: 'NO_REVIEWER', since: ago(2 * HOUR), role: 'coordinator', who: 'coordinator', next: 'reserve a reviewer outside', why: builders[2] });
  const conflictFinding = expect(`UNLANDED_CONFLICT:item:${conflict}`, { cause: 'UNLANDED_CONFLICT', since: ago(2 * HOUR), role: 'builder', who: builders[3], next: 'merge main into its branch', why: ['conflicts with main', 'a.txt'] });
  assert.deepEqual(conflictFinding.detail.files, ['a.txt'], 'the conflict names its files');
  expect(`UNLANDED_READY:item:${ready}`, { cause: 'UNLANDED_READY', since: ago(2 * HOUR), role: 'coordinator', who: 'coordinator', next: 'pullboard land', why: 'merges cleanly onto main' });
  expect(`UNLANDED_HELD:item:${heldAccept}`, { cause: 'UNLANDED_HELD', since: ago(2 * HOUR), role: 'coordinator', who: 'coordinator', next: `pullboard hold ${heldAccept} --off`, why: 'waiting for the person to pick the wording' });
  expect(`UNLANDED_STACKED:item:${stacked}`, { cause: 'UNLANDED_STACKED', since: ago(2 * HOUR), role: 'reviewer', who: null, next: `pullboard next --verify ${parentItem}`, why: `#${parentItem}` });
  expect(`HOLD_STALE:item:${staleHold}`, { cause: 'HOLD_STALE', since: ago(30 * HOUR), role: 'coordinator', who: 'coordinator', next: `pullboard hold ${staleHold} --off`, why: 'waiting for the design' });
  expect('HOLD_STALE:lane:docs', { cause: 'HOLD_STALE', since: ago(30 * HOUR), role: 'coordinator', who: 'coordinator', next: 'pullboard hold docs --off', why: 'docs wait for the release notes' });
  expect(`CONFLICT_HOLD_CLEARS:item:${conflictHold}`, { cause: 'CONFLICT_HOLD_CLEARS', since: ago(HOUR / 6), role: 'coordinator', who: 'coordinator', next: `pullboard hold ${conflictHold} --off`, why: 'now merges cleanly onto main' });
  expect(`REWORK_UNCLAIMED:item:${rejected}`, { cause: 'REWORK_UNCLAIMED', since: ago(2 * HOUR), role: 'coordinator', who: 'coordinator', next: 'pullboard sentinel run --health-only', why: ['rejected by', 'TEST_FAILURE'] });
  expect(`REWORK_UNCLAIMED:item:${reopened}`, { cause: 'REWORK_UNCLAIMED', since: ago(2 * HOUR), role: 'builder', who: builders[7], next: `pullboard claim ${reopened}`, why: 'reopened by coordinator' });
  expect(`AFTER_WITHDRAWN:item:${orphan}`, { cause: 'AFTER_WITHDRAWN', since: ago(2 * HOUR), role: 'coordinator', who: 'coordinator', next: `pullboard edit ${orphan} --after none`, why: [`#${withdrawn}`, 'superseded by the new layout'] });
  expect(`DECISION_UNANSWERED:shout:${ask}`, { cause: 'DECISION_UNANSWERED', since: ago(2 * HOUR), role: 'coordinator', who: 'coordinator', next: `pullboard answer ${ask}`, why: 'Which file owns the wording?' });
  expect('RELEASE_OVERDUE:release:v0.1.0', { cause: 'RELEASE_OVERDUE', since: ago(72 * HOUR), role: 'coordinator', who: 'coordinator', next: 'publish the release after v0.1.0', why: `#${shipped}` });
  expect(`REWORK_UNCLAIMED:item:${later}`, { cause: 'REWORK_UNCLAIMED', since: ago(2 * HOUR),
    role: 'coordinator', who: 'coordinator', next: 'pullboard sentinel run --health-only', why: 'rejected by' });
  assert.ok(!report.waiting.some(entry => entry.item === later), 'an unattended reject interrupts even when its release is later');
  for (const id of [parentItem, conflictHold, shipped]) assert.ok(![...byKey.values()].some((entry) => entry.item === id && !entry.key.startsWith('CONFLICT_HOLD')), `#${id} is moving, not stuck`);

  const patient = boardHealth(box.file, { dispatchHealth, root: box.root, config: { health: { stuck: '3h', holds: '2d' } }, now: new Date(NOW) });
  assert.deepEqual(patient.thresholds, { stuck: '3h', holds: '2d', release: '1d' }, 'pullboard.json health thresholds replace the defaults');
  assert.ok(!patient.stuck.some((entry) => ['NO_REVIEWER', 'HOLD_STALE'].includes(entry.cause)
    || entry.cause === 'REWORK_UNCLAIMED' && entry.item === reopened), 'longer thresholds clear ordinary younger waits');
  for (const id of [rejected, later]) assert.ok(patient.stuck.some(entry => entry.item === id && entry.cause === 'REWORK_UNCLAIMED'),
    'the approved ten-minute rejection deadline is independent of the configurable ordinary health threshold');
  assert.throws(() => boardHealth(box.file, { dispatchHealth, root: box.root, config: { health: { stuck: 'soon' } }, now: new Date(NOW) }), /BAD_CONFIG|health\.stuck/u);

  const text = await cli(box.root, ['health']);
  assert.equal(text.code, 1);
  const lines = text.stdout.trim().split('\n');
  assert.equal(lines[0], `${report.stuck.length} stuck:`);
  const lapsedLine = lines.find((line) => line.startsWith(`  #${lapsed} `));
  assert.equal(lapsedLine, `  #${lapsed} claim lapsed, since 2026-10-17 10:00 (2h): ${builders[0]}'s lease ran out and nobody is building it. Next, ${builders[0]} (builder): renew it with pullboard claim ${lapsed}.`);
  assert.ok(lines.some((line) => line.startsWith(`  #${conflict} `) && line.includes('a.txt') && line.includes(`${builders[3]} (builder)`)), 'the text names the conflicting files and the builder');
  assert.ok(lines.some(line => line.startsWith(`  #${later} `) && line.includes('the coordinator')
    && line.includes('pullboard sentinel run --health-only')), 'a later-release reject still prints its coordinator handback action');
  assert.deepEqual(boardDigest(box.file), beforeBoard, 'text mode changes nothing either');
  assert.deepEqual(checkout(box), beforeCheckout);
});

test('health on a healthy board says nothing is stuck [A6]', async (t) => {
  const box = repo(t);
  const commit = box.git(['rev-parse', 'HEAD']);
  const missing = await cli(box.root, ['health']);
  assert.equal(missing.code, 0, missing.stderr);
  assert.equal(missing.stdout, 'nothing is stuck\n', 'a repo with no board yet has nothing stuck');

  const { board } = boardAt(box);
  store.register(board, { lane: 'coordinator', path: box.root });
  store.closeBoard(board);
  const empty = await cli(box.root, ['health', '--json']);
  assert.equal(empty.code, 0, empty.stderr);
  const emptyReport = JSON.parse(empty.stdout);
  assert.deepEqual([emptyReport.stuck, emptyReport.waiting], [[], []], 'an empty board has nothing stuck');
  assert.equal((await cli(box.root, ['health'])).stdout, 'nothing is stuck\n');

  const moving = boardAt(box);
  t.after(() => store.closeBoard(moving.board));
  const builder = store.register(moving.board, { lane: 'core', path: join(box.dir, 'core-1') });
  const second = store.register(moving.board, { lane: 'core', path: join(box.dir, 'core-2') });
  const reviewer = store.register(moving.board, { lane: 'review', path: join(box.dir, 'review-1') });
  moving.at(30 * HOUR);
  const done = store.addItem(moving.board, { by: 'coordinator', lane: 'core', title: 'Done' });
  store.claim(moving.board, done, { agentId: builder, lane: 'core', leaseMs: 2 * HOUR, freeze });
  submitFixture(moving.board, done, { agentId: builder, commit, tree: 'tree' });
  store.verify(moving.board, done, { agentId: reviewer, decision: 'ACCEPT', reason: 'CRITERION_MET', note: 'ran it', head: commit, digest: 'digest:Done', policy: 'any' });
  store.merged(moving.board, done, { agentId: 'coordinator', commit });
  moving.at(HOUR / 2);
  const building = store.addItem(moving.board, { by: 'coordinator', lane: 'core', title: 'Building' });
  store.claim(moving.board, building, { agentId: builder, lane: 'core', leaseMs: 2 * HOUR, freeze });
  const reviewing = store.addItem(moving.board, { by: 'coordinator', lane: 'core', title: 'Reviewing' });
  store.claim(moving.board, reviewing, { agentId: second, lane: 'core', leaseMs: 2 * HOUR, freeze });
  submitFixture(moving.board, reviewing, { agentId: second, commit, tree: 'tree' });
  store.reserveReview(moving.board, reviewing, { agentId: reviewer, leaseMs: HOUR, policy: 'any' });
  store.addItem(moving.board, { by: 'coordinator', lane: 'core', title: 'Fresh work' });
  const asked = store.shout(moving.board, { from: builder, to: 'coordinator', text: 'Which wording?', lanes: ['core', 'docs', 'review'], decision: true });
  store.answerDecision(moving.board, asked, { agentId: 'coordinator', text: 'the short one', lanes: ['core', 'docs', 'review'] });
  store.holdLane(moving.board, 'docs', { agentId: 'coordinator', reason: 'a short pause' });
  const before = boardDigest(box.file);
  const healthy = await cli(box.root, ['health', '--json']);
  assert.equal(healthy.code, 0, healthy.stdout);
  const report = JSON.parse(healthy.stdout);
  assert.deepEqual(report.stuck, [], `a moving board has nothing stuck: ${report.stuck.map((entry) => entry.key).join(', ')}`);
  // Seats with no worktree or recent activity are listed once as retired, never as stuck (#940).
  const retired = report.retired.map((seat) => seat.agent).join(', ');
  assert.equal((await cli(box.root, ['health'])).stdout, `nothing is stuck\n${retired ? `retired seats, not counted as agents (quiet for 30 minutes or more, or their worktree is gone): ${retired}\n` : ''}`);
  assert.deepEqual(boardDigest(box.file), before, 'health changes nothing on a healthy board');
});

test('health preserves a real stuck finding instead of the exact healthy body [A6]', async t => {
  const box = repo(t);
  const { board, at } = boardAt(box);
  store.register(board, { lane: 'coordinator', path: box.root });
  at(48 * HOUR);
  store.holdLane(board, 'docs', { agentId: 'coordinator', reason: 'A genuinely stale fixture lane hold.' });
  store.closeBoard(board);
  const result = await cli(box.root, ['health']);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^\d+ stuck:/mu);
  assert.notEqual(result.stdout, 'nothing is stuck\n', 'the unchanged healthy-body oracle still refuses a genuine finding');
  assert.ok(!result.stdout.includes('nothing is stuck'));
  const json = await cli(box.root, ['health', '--json']);
  assert.equal(json.code, 1, json.stdout + json.stderr);
  assert.ok(JSON.parse(json.stdout).stuck.some(finding => finding.cause === 'HOLD_STALE' && finding.subject === 'lane docs'));
});

test('a submitted item with no reviewer goes to the coordinator, not its builder [A6]', async (t) => {
  // A board with no review lane still gets a command the real shout path accepts: it goes to the
  // coordinator, and the builder is never the owner of their own review (#910).
  const box = repo(t);
  writeFileSync(join(box.root, 'pullboard.json'), `${JSON.stringify({ gate: 'true', lanes: { core: { owns: ['src/'] } } }, null, 2)}\n`);
  const commit = box.git(['rev-parse', 'HEAD']);
  const { board, at } = boardAt(box);
  store.register(board, { lane: 'coordinator', path: box.root });
  const builder = store.register(board, { lane: 'core', path: join(box.dir, 'core-1') });
  at(3 * HOUR);
  const waiting = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Waiting review' });
  store.claim(board, waiting, { agentId: builder, lane: 'core', leaseMs: 2 * HOUR, freeze });
  submitFixture(board, waiting, { agentId: builder, commit, tree: 'tree' });
  store.closeBoard(board);

  const result = await cli(box.root, ['health', '--json']);
  assert.equal(result.code, 1, `a submitted item with no reviewer is stuck: ${result.stderr}`);
  const entry = JSON.parse(result.stdout).stuck.find((found) => found.key === `NO_REVIEWER:item:${waiting}`);
  assert.ok(entry, `health lists the unreviewed submission; found ${result.stdout}`);
  assert.notEqual(entry.owner.who, builder, 'the builder is never the owner of their own review');
  assert.deepEqual(entry.owner, { role: 'coordinator', who: 'coordinator' }, 'the coordinator owns the missing reviewer');
  assert.ok(entry.next.includes(`reserve a reviewer outside ${builder}'s controller and session`), `the next step names a reviewer outside the builder: ${entry.next}`);
  assert.ok(!entry.next.includes('pullboard next --verify'), `the next step never sends the builder to verify: ${entry.next}`);
  assert.ok(!entry.command.includes('pullboard next --verify'), `the command never sends the builder to verify: ${entry.command}`);

  // The generated command runs through the real shout path on this board, reaching every agent.
  const argv = entry.command.match(/"[^"]*"|\S+/gu).map((token) => token.replace(/^"|"$/gu, ''));
  assert.equal(argv[0], 'pullboard', entry.command);
  const shouted = await cli(box.root, argv.slice(1));
  assert.equal(shouted.code, 0, `the generated command is accepted: ${shouted.stderr}${shouted.stdout}`);
  const reread = openBoard(box.file, { now: () => new Date(NOW) });
  try {
    const sent = store.allShouts(reread).filter((shout) => shout.shout_to === 'all').map((shout) => shout.shout_text);
    assert.ok(sent.some((text) => text.includes(`#${waiting} needs a reviewer outside ${builder}'s controller and session`)), `every agent hears the request: ${sent.join(' | ')}`);
  } finally { store.closeBoard(reread); }
  const text = await cli(box.root, ['health']);
  assert.ok(text.stdout.includes('Next, the coordinator: reserve a reviewer outside'), `the text names the coordinator: ${text.stdout}`);
});

test('item history survives garbage collection mid-read [A6]', () => {
  // A stand-in database whose statement lives only while something references it, as node:sqlite's
  // does on Node 22.13, with garbage collection forced while the history is read (#874).
  const health = pathToFileURL(resolve(import.meta.dirname, '../../../../packages/health/index.js')).href;
  const script = `
    import { DatabaseSync } from 'node:sqlite';
    import { itemHistory } from ${JSON.stringify(health)};
    const real = new DatabaseSync(':memory:');
    real.exec('CREATE TABLE event (event_id INTEGER PRIMARY KEY, event_at TEXT, event_by TEXT, event_kind TEXT, item_id INTEGER, event_detail TEXT); CREATE INDEX event_item_id_event_id ON event (item_id, event_id)');
    const insert = real.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)');
    for (let i = 0; i < 20000; i += 1) insert.run('2026-10-18T00:00:00.000Z', 'agent', i % 3 ? 'claim' : 'submit', i % 50, '{}');
    // Defined outside any scope that holds the statement, so only the code under test can keep it alive.
    let reads = 0;
    let collections = 0;
    const collecting = (rows) => ({ [Symbol.iterator]() { return this; }, next() { reads += 1; if (reads % 500 === 0) { globalThis.gc(); collections += 1; } return rows.next(); } });
    const db = { prepare: (sql) => { const statement = real.prepare(sql); return { iterate: (...values) => collecting(statement.iterate(...values)) }; } };
    const history = itemHistory(db, Array.from({ length: 50 }, (_, id) => id));
    process.stdout.write(String(history.size) + ':' + String(collections));
  `;
  const child = runFixtureChild(process.execPath, ['--expose-gc', '--no-warnings', '--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, `reading item history must not lose its statement to garbage collection: ${child.stderr}`);
  assert.match(child.stdout, /^50:[1-9]\d*$/u, 'every item is read and garbage collection runs across item cursors');
});

test('health names a route with open work and no agent [N2,B13]', async (t) => {
  const box = repo(t);
  const { board, at } = boardAt(box);
  at(HOUR / 12);
  store.register(board, { lane: 'coordinator', path: box.root });
  const light = store.register(board, { lane: 'core', route: 'light', path: join(box.dir, 'core-light') });
  const waiting = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Mid work', route: 'mid',
    criterion: 'The mid work is done when its test passes.', check: 'true', brief: 'Files:\n- src/mid.js\nTest:\n- the mid work runs' });
  store.closeBoard(board);
  const result = await cli(box.root, ['health', '--json']);
  assert.equal(result.code, 1, `a queue fault is stuck work: ${result.stderr}`);
  const report = JSON.parse(result.stdout);
  const route = report.stuck.find((entry) => entry.key === 'ROUTE_UNSERVED:route:mid');
  assert.ok(route, `health names the route nobody serves: ${result.stdout}`);
  assert.deepEqual(route.owner, { role: 'coordinator', who: 'coordinator' }, 'the coordinator starts an agent on the route');
  assert.ok(route.why.includes(`#${waiting}`), `the finding names the waiting item: ${route.why}`);
  assert.equal(route.command, 'pullboard worktree core --route mid', `the command starts an agent on the route: ${route.command}`);
  assert.ok(route.next.includes('pullboard worktree core --route mid') && route.next.includes('PULLBOARD_MODEL'), `the next step names the worktree command and the model: ${route.next}`);
  assert.ok(!route.command.includes('pullboard join'), 'join from the main checkout would enroll the coordinator, not start an agent');
  assert.ok(!report.stuck.some((entry) => entry.owner?.who === light && entry.key.startsWith('ROUTE_UNSERVED')), 'the light agent is not named for a mid route');
});

test('health names a rank inversion [N2,B13]', async (t) => {
  const box = repo(t);
  const { board, at } = boardAt(box);
  at(HOUR / 12);
  store.register(board, { lane: 'coordinator', path: box.root });
  const builder = store.register(board, { lane: 'core', path: join(box.dir, 'core-1') });
  const earlier = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Earlier work' });
  const later = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Later work' });
  store.claim(board, later, { agentId: builder, lane: 'core', leaseMs: 2 * HOUR, freeze });
  store.closeBoard(board);
  const result = await cli(box.root, ['health', '--json']);
  const report = JSON.parse(result.stdout);
  const inversion = report.stuck.find((entry) => entry.key === `RANK_INVERSION:item:${later}`);
  assert.ok(inversion, `health names the claim that ranks behind a free item: ${result.stdout}`);
  assert.deepEqual(inversion.owner, { role: 'builder', who: builder }, 'the holder owns its own rank inversion');
  assert.ok(inversion.why.includes(`#${earlier}`), `the finding names the free item ahead: ${inversion.why}`);
  assert.ok(inversion.next.includes(`claim #${earlier}`), `the next step claims it: ${inversion.next}`);
});

/** A real board permits a parent and child claim; advice must preserve the claim it does not release. */
test('health models only its named release when a child claim keeps the preferred file occupied [N2,B13]', (t) => {
  const box = repo(t);
  const { board, at } = boardAt(box);
  try {
    at(HOUR / 12);
    store.register(board, { lane: 'coordinator', path: box.root });
    const builder = store.register(board, { lane: 'core', route: 'strong', path: join(box.dir, 'core-multiple') });
    const earlier = store.addItem(board, { by: 'coordinator', lane: 'core', route: 'strong',
      title: 'Older free work on the child file', brief: 'Files: src/child.js' });
    const held = store.addItem(board, { by: 'coordinator', lane: 'core', route: 'strong',
      title: 'Current parent work on a separate file', brief: 'Files: src/parent.js' });
    const child = store.addItem(board, { by: 'coordinator', lane: 'core', route: 'strong', parentId: held,
      title: 'A legitimate live child claim', brief: 'Files: src/child.js' });
    store.claim(board, held, { agentId: builder, lane: 'core', leaseMs: 2 * HOUR, freeze });
    store.claim(board, child, { agentId: builder, lane: 'core', leaseMs: 2 * HOUR, freeze });
    assert.equal(store.getItem(board, held).item_owner, builder);
    assert.equal(store.getItem(board, child).item_owner, builder, 'the second claim uses the normal child exception');
    const before = boardHealth(box.file, { dispatchHealth, root: box.root, now: new Date(NOW) });
    assert.ok(!before.stuck.some(entry => entry.key === `RANK_INVERSION:item:${held}`),
      'releasing only the parent would leave the child overlap; the older free item does not rank ahead');

    store.release(board, child, builder, 'Free the child claim for the health control.', 'OTHER');
    assert.equal(store.getItem(board, held).item_status, 'claimed', 'the control releases exactly one claim');
    const after = boardHealth(box.file, { dispatchHealth, root: box.root, now: new Date(NOW) });
    const advice = after.stuck.find(entry => entry.key === `RANK_INVERSION:item:${held}`);
    assert.ok(advice, 'once the child occupancy is actually removed, older free work ranks ahead');
    assert.equal(advice.detail.ahead, earlier);
    assert.equal(advice.command, `pullboard release ${held} --reason ROUTED_ELSEWHERE`);
    const [, verb, id] = advice.command.split(' ');
    assert.equal(verb, 'release');
    store.release(board, Number(id), builder, 'Apply the health advice to the fixture claim.', 'OTHER');
    assert.equal(store.nextFor(board, { agentId: builder, lane: 'core' }).item.item_id, earlier,
      'the single release advice now agrees with the normal next selector');
  } finally { store.closeBoard(board); }
});

test('every printed next step runs as pasted through main() [N2,B13]', async (t) => {
  // Each next step health prints runs from the directory a person would use: the worktree commands from
  // the main checkout, and the agent steps from that agent's own worktree (#798).
  const box = repo(t);
  const brief = { criterion: 'The item is done when its test passes.', check: 'true', brief: 'Files:\n- src/mid.js\nTest:\n- the mid work runs' };
  const { board, at } = boardAt(box);
  at(40 * HOUR);
  store.register(board, { lane: 'coordinator', path: box.root });
  const idlePath = join(box.dir, 'core-idle');
  box.git(['worktree', 'add', '-q', idlePath, '-b', 'core-idle']);
  // A mid seat that is around can serve mid work but not the strong item, so every kind of finding appears (#940).
  const idle = store.register(board, { lane: 'core', route: 'mid', path: idlePath });
  at(HOUR / 12);
  // The idle seat's agent is around (it shouted five minutes ago) but has pulled nothing for 40 hours (#940).
  store.shout(board, { from: idle, to: 'coordinator', text: 'still here', lanes: ['core'] });
  const holderPath = join(box.dir, 'core-holder');
  box.git(['worktree', 'add', '-q', holderPath, '-b', 'core-holder']);
  const holder = store.register(board, { lane: 'core', route: 'mid', path: holderPath });
  store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Earlier mid', route: 'mid', ...brief });
  const later = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Later mid', route: 'mid', ...brief });
  const strong = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Strong work' });
  // Earlier mid shares src/mid.js with the held claim, so next gives the idle seat only this one (#1114).
  store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Other mid', route: 'mid', ...brief, brief: 'Files:\n- src/other.js\nTest:\n- the other work runs' });
  store.claim(board, later, { agentId: holder, lane: 'core', leaseMs: 2 * HOUR, freeze });
  // A seat silent for two minutes loses its claim to the board (liveness), so the holder is alive when the printed steps run.
  at(30_000);
  heartbeatSeat(board, holder);
  store.closeBoard(board);

  const before = await cli(box.root, ['health', '--json']);
  const printed = JSON.parse(before.stdout).stuck.filter((entry) => entry.command);
  const keys = printed.map((entry) => entry.key);
  for (const key of [`ROUTE_UNSERVED:route:strong`, `ITEM_UNTAKEABLE:item:${strong}`, `IDLE_AGENT:agent:${idle}`, `RANK_INVERSION:item:${later}`]) {
    assert.ok(keys.includes(key), `health prints a next step for ${key}: ${keys.join(', ')}`);
  }
  const folders = { [idle]: idlePath, [holder]: holderPath };
  const saved = process.env.PULLBOARD_MODEL;
  process.env.PULLBOARD_MODEL = 'claude-haiku-5-5';
  try {
    for (const entry of printed) {
      assert.ok(!entry.command.startsWith('pullboard join'), `${entry.key} never runs join: ${entry.command}`);
      const argv = entry.command.match(/"[^"]*"|\S+/gu).slice(1).map((token) => token.replace(/^"|"$/gu, ''));
      const ran = await cli(folders[entry.owner.who] ?? box.root, argv);
      assert.equal(ran.code, 0, `${entry.key} runs as printed: pullboard ${argv.join(' ')}: ${ran.stderr}${ran.stdout}`);
    }
  } finally {
    if (saved === undefined) delete process.env.PULLBOARD_MODEL; else process.env.PULLBOARD_MODEL = saved;
  }
  const after = JSON.parse((await cli(box.root, ['health', '--json'])).stdout);
  assert.ok(!after.stuck.some((entry) => entry.key === 'ROUTE_UNSERVED:route:strong'), 'the worktree the next step starts serves the strong route');
  assert.ok(!after.stuck.some((entry) => entry.key === `RANK_INVERSION:item:${later}`), 'the release the next step names clears the rank inversion');
});

/** Commit a pullboard.json whose gate, and optional positive control, the next gate run reads. */
function commitPolicy(box, policy) {
  writeFileSync(join(box.root, 'pullboard.json'), `${JSON.stringify({ gate: 'true', lanes: { core: { owns: ['src/'] }, docs: { owns: ['docs/'] }, review: { owns: [] } }, ...policy }, null, 2)}\n`);
  box.git(['add', 'pullboard.json']);
  box.git(['commit', '-q', '-m', 'chore: gate policy']);
}

/** Health at the real clock, since a gate run records the moment it actually ran. */
async function healthNow(cwd) {
  let stdout = '';
  const code = await main(['health', '--json'], {
    cwd, stdout: { isTTY: false, write: (text) => { stdout += text; } }, stderr: { write: () => {} },
  });
  return { code, report: JSON.parse(stdout) };
}

test('health reports a gate whose positive control fails [C7,D1]', async (t) => {
  const box = repo(t);
  commitPolicy(box, { gate: 'true', positiveControl: 'false' });
  const ran = await cli(box.root, ['gate']);
  assert.equal(ran.code, 0, 'the gate itself is green, so only its known-good case betrays it');
  const { code, report } = await healthNow(box.root);
  assert.equal(code, 1, 'a failing positive control is stuck work, not green');
  const alarm = report.stuck.find((entry) => entry.cause === 'GATE_CONTROL_FAILED');
  assert.ok(alarm, 'health names the gate whose positive control failed');
  assert.equal(alarm.subject, 'gate');
  assert.match(alarm.why, /positive control/u);
  assert.equal(alarm.detail.positiveControl, 'false');
  assert.equal(alarm.detail.runs.at(-1).control, false, 'the finding carries the last run and its control result');
});

test('health reports a gate that refused every run [C7,D1]', async (t) => {
  const box = repo(t);
  commitPolicy(box, { gate: 'false' });
  for (let run = 1; run <= 2; run += 1) assert.equal((await cli(box.root, ['gate'])).code, 1, `run ${run} is refused`);
  assert.equal((await healthNow(box.root)).report.stuck.some((entry) => entry.cause === 'GATE_REFUSED_EVERY_RUN'), false, 'two refusals are not yet an alarm');
  assert.equal((await cli(box.root, ['gate'])).code, 1, 'run 3 is refused');
  const { code, report } = await healthNow(box.root);
  assert.equal(code, 1);
  const alarm = report.stuck.find((entry) => entry.cause === 'GATE_REFUSED_EVERY_RUN');
  assert.ok(alarm, 'health names a gate that refused every run in its window');
  assert.equal(alarm.subject, 'gate');
  assert.deepEqual(alarm.detail.runs.map((run) => run.green), [false, false, false], 'the finding lists the last runs, all refused');
});

test('a positive control inherits the gate slot it runs under [C7,D1]', async (t) => {
  const box = repo(t);
  const resources = pathToFileURL(resolve('packages/resources/index.js')).href;
  // The control asks whether it inherited the gate's admission; a child that does not is refused and reads red.
  const probe = `node --input-type=module -e "const { inheritedGateSlot } = await import('${resources}'); process.exit(inheritedGateSlot({ root: process.cwd() }) ? 0 : 1)"`;
  commitPolicy(box, { gate: 'true', positiveControl: probe });
  const runGate = frontDoorRunGate;
  const config = JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8'));
  const gate = await runGate(box.root, config, { executionServices, trustStamp: false });
  assert.equal(gate.isGreen, true, 'the gate itself is green');
  const run = gateRuns(box.root).at(-1);
  assert.equal(run.control, true, 'the positive control saw the inherited gate slot and passed');
  assert.ok(run.controlLog && existsSync(run.controlLog), 'the control keeps its raw output in the gate evidence');
  assert.ok(run.controlProfile && existsSync(run.controlProfile), 'the control keeps its timing profile in the gate evidence');
});

/** A board with `gone` seats quiet for three days and `live` seats that shouted five minutes ago beside open core work. */
function seatedBoard(t, { gone, live }) {
  const box = repo(t);
  const { board, at } = boardAt(box);
  at(72 * HOUR);
  store.register(board, { lane: 'coordinator', path: box.root });
  for (let n = 0; n < gone; n += 1) store.register(board, { lane: 'core', path: join(box.dir, `gone-${n}`) });
  const seats = Array.from({ length: live }, (_, n) => {
    const path = join(box.dir, `live-${n}`);
    mkdirSync(path);
    return store.register(board, { lane: 'core', path });
  });
  store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Open core work', criterion: 'The work is done when its test passes.' });
  at(5 * 60_000);
  for (const seat of seats) store.shout(board, { from: seat, to: 'coordinator', text: 'still here', lanes: ['core'] });
  at(0);
  /** Run one real sentinel scan and record it, returning the sentinel's shouts. */
  const scan = () => {
    store.recordHealthFindings(board, { agentId: 'coordinator', ...scanHealthSentinel(box.file, { root: box.root, config: loadConfig(box.root), now: new Date(NOW) }) });
    return store.allShouts(board).filter((notice) => notice.shout_from === 'sentinel');
  };
  t.after(() => store.closeBoard(board));
  return { box, board, seats, scan };
}

test('health never reports a long-gone seat as an idle agent [A6,N2]', async (t) => {
  const { box, seats: [active], scan } = seatedBoard(t, { gone: 500, live: 1 });
  const shouts = scan();
  assert.ok(shouts.length <= 1, `at most one shout, for the active seat: ${shouts.map((notice) => notice.shout_text.slice(0, 80)).join(' | ')}`);
  assert.ok(shouts.every((notice) => notice.shout_to === active && notice.shout_text.includes(`${active} idle beside work it could take`)), 'the one shout is the active seat hearing it is idle');
  const report = JSON.parse((await cli(box.root, ['health', '--json'])).stdout);
  assert.deepEqual(report.stuck.filter((entry) => entry.cause === 'IDLE_AGENT').map((entry) => entry.subject), [active], 'only the active seat is an idle agent');
  assert.equal(report.retired.length, 500, 'the quiet seats are listed once as retired');
  const text = await cli(box.root, ['health']);
  assert.equal(text.stdout.split('\n').filter((line) => line.startsWith('retired seats')).length, 1, 'retired seats get one line');
});

test('one health run sends at most ten stuck shouts and names how many it held back [A6,N2]', (t) => {
  const { seats, scan } = seatedBoard(t, { gone: 0, live: 12 });
  const shouts = scan();
  assert.equal(shouts.length, 11, 'ten notices and one that names the rest');
  assert.match(shouts.at(-1).shout_text, /^Health: 3 more notices from this run were held back/u);
  assert.equal(shouts.filter(notice => notice.shout_text.includes('ROUTE_WORK_SHORTAGE')).length, 1,
    'the coordinator route shortage occupies one of the same ten notice places');
  assert.equal(shouts.at(-1).shout_to, 'coordinator');
  assert.equal(seats.length, 12);
});

test('a recurring job that missed its cadence is a finding [D1,C7]', async (t) => {
  const box = repo(t);
  const { board, at } = boardAt(box);
  store.register(board, { lane: 'coordinator', path: box.root });
  const worker = store.register(board, { lane: 'core', path: join(box.dir, 'core-1') });
  at(10 * HOUR);
  for (const name of ['nightly', 'edge', 'fresh', 'never']) store.declareJob(board, { agentId: 'coordinator', name, every: '10m', owner: 'coordinator' });
  at(9 * HOUR);
  store.recordJobRun(board, { agentId: worker, name: 'nightly' });
  at(16 * 60_000);
  store.recordJobRun(board, { agentId: worker, name: 'edge' });
  at(14 * 60_000);
  store.recordJobRun(board, { agentId: worker, name: 'fresh' });
  store.closeBoard(board);
  const { code, stdout } = await cli(box.root, ['health', '--json']);
  assert.equal(code, 1, 'a silent job is stuck work');
  const missed = JSON.parse(stdout).stuck.filter((entry) => entry.cause === 'JOB_MISSED').map((entry) => entry.subject).sort();
  assert.deepEqual(missed, ['job:edge', 'job:never', 'job:nightly'], 'a run 14 minutes ago is on time for a 10 minute job; 16 minutes ago and never run are missed');
  const found = JSON.parse(stdout).stuck.find((entry) => entry.subject === 'job:nightly');
  assert.match(found.why, /nightly/u);
  assert.ok(found.why.includes(ago(9 * HOUR)), `the finding names the last run: ${found.why}`);
  assert.match(found.why, /owner is coordinator/u);
  assert.equal(found.owner.who, 'coordinator');
  const scan = scanHealthSentinel(box.file, { root: box.root, config: loadConfig(box.root), now: new Date(NOW) });
  assert.ok(scan.findings.some((entry) => entry.key === 'JOB_MISSED:job:nightly'), 'the sentinel feed carries the finding');
});

test('an agent cannot widen a declared cadence [D1,C7]', (t) => {
  const box = repo(t);
  const { board } = boardAt(box);
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: box.root });
  const worker = store.register(board, { lane: 'core', path: join(box.dir, 'core-1') });
  store.declareJob(board, { agentId: 'coordinator', name: 'loop', every: '10m', owner: 'coordinator' });
  assert.throws(() => store.declareJob(board, { agentId: worker, name: 'loop', every: 'daily', owner: worker }), (error) => error.code === 'JOB_CADENCE_COORDINATOR_ONLY');
  assert.equal(recurringJobs(board)[0].every, '10m');
  assert.equal(store.declareJob(board, { agentId: 'coordinator', name: 'loop', every: '1h', owner: 'coordinator' }).every, '1h', 'the coordinator may change it');
});

test('a missed job is reported once per episode, not on every scan [D1,C7]', (t) => {
  const box = repo(t);
  const { board, at } = boardAt(box);
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: box.root });
  const worker = store.register(board, { lane: 'core', path: join(box.dir, 'core-1') });
  at(10 * HOUR);
  store.declareJob(board, { agentId: 'coordinator', name: 'sweep', every: '10m', owner: 'coordinator' });
  at(0);
  /** Scan and record as the sentinel does; returns what the scan published, or null when nothing changed. */
  const scan = () => {
    const seen = scanHealthSentinel(box.file, { root: box.root, config: loadConfig(box.root), now: new Date(NOW) });
    if (seen) store.recordHealthFindings(board, { agentId: 'coordinator', ...seen });
    return seen;
  };
  assert.ok(scan()?.findings.some((entry) => entry.key === 'JOB_MISSED:job:sweep'), 'the first scan reports the miss');
  const notices = () => store.allShouts(board).filter((notice) => notice.shout_from === 'sentinel').length;
  const first = notices();
  assert.ok(first >= 1, 'the owner hears of it');
  assert.equal(scan(), null, 'a second scan of the same episode publishes nothing');
  assert.equal(notices(), first, 'and shouts nothing');
  at(5 * 60_000);
  store.recordJobRun(board, { agentId: worker, name: 'sweep' });
  at(0);
  const cleared = scan();
  assert.ok(cleared && !cleared.findings.some((entry) => entry.cause === 'JOB_MISSED'), 'a run ends the episode and the scan publishes the clearing');
  assert.equal(scan(), null, 'and then it is quiet');
});

test('rank inversion uses original claim order across reorder, renewal and new work [N2,B13]', (t) => {
  const box = repo(t);
  const { board, at } = boardAt(box);
  try {
    at(HOUR / 12);
    store.register(board, { lane: 'coordinator', path: box.root });
    const builder = store.register(board, { lane: 'core', path: join(box.dir, 'rank-history') });
    const first = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'First ranked work' });
    const second = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Second ranked work' });
    store.addMilestone(board, { agentId: 'coordinator', reason: 'Fixture controls historical ordering.', name: 'rank-history', items: [first, second] });
    store.orderMilestoneItems(board, 'rank-history', { agentId: 'coordinator', reason: 'Fixture controls historical ordering.', items: [first, second] });
    store.claim(board, first, { agentId: builder, lane: 'core', leaseMs: 2 * HOUR, freeze });
    store.orderMilestoneItems(board, 'rank-history', { agentId: 'coordinator', reason: 'Fixture controls historical ordering.', items: [second, first] });
    /** Inspect actual read-only health output without changing a worktree. */
    const inversion = id => boardHealth(box.file, { dispatchHealth, root: box.root, now: new Date(NOW) }).stuck
      .find(entry => entry.key === `RANK_INVERSION:item:${id}`);
    assert.equal(inversion(first), undefined, 'reordering after a valid claim must not tell its builder to drop it');
    store.claim(board, first, { agentId: builder, lane: 'core', leaseMs: 2 * HOUR, freeze });
    assert.equal(inversion(first), undefined, 'renewal preserves the original claim ordering');
    store.release(board, first, builder, 'Fixture starts a fresh claim.', 'OTHER');
    store.claim(board, first, { agentId: builder, lane: 'core', leaseMs: 2 * HOUR, freeze });
    assert.equal(inversion(first)?.detail.ahead, second, 'a new claim after the reorder still names the free item already above it');
    store.release(board, first, builder, 'Fixture starts a fresh claim.', 'OTHER');
    store.claim(board, second, { agentId: builder, lane: 'core', leaseMs: 2 * HOUR, freeze });
    const added = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Newly inserted priority' });
    assert.ok(store.milestones(board).find(entry => entry.name === 'rank-history').items.includes(added), 'add automatically places the new work');
    store.orderMilestoneItems(board, 'rank-history', { agentId: 'coordinator', reason: 'Fixture controls historical ordering.', items: [added, second, first] });
    assert.equal(inversion(second), undefined, 'work added and ranked after a claim cannot accuse that original claim');
  } finally { store.closeBoard(board); }
});

test('rank inversion does not treat subsequently freed work as free at claim time [N2,B13]', (t) => {
  const box = repo(t);
  const { board, at } = boardAt(box);
  try {
    at(HOUR / 12);
    store.register(board, { lane: 'coordinator', path: box.root });
    const firstBuilder = store.register(board, { lane: 'core', path: join(box.dir, 'rank-first') });
    const secondBuilder = store.register(board, { lane: 'core', path: join(box.dir, 'rank-second') });
    const first = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Earlier occupied work' });
    const second = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Later available work' });
    store.claim(board, first, { agentId: firstBuilder, lane: 'core', leaseMs: 2 * HOUR, freeze });
    store.claim(board, second, { agentId: secondBuilder, lane: 'core', leaseMs: 2 * HOUR, freeze });
    store.release(board, first, firstBuilder, 'Fixture frees the occupied higher item.', 'OTHER');
    const report = boardHealth(box.file, { dispatchHealth, root: box.root, now: new Date(NOW) });
    assert.ok(!report.stuck.some(entry => entry.key === `RANK_INVERSION:item:${second}`),
      'the higher item was occupied when the second builder selected its work');
  } finally { store.closeBoard(board); }
});

test('unrelated milestone changes preserve an existing rank inversion [N2,B13]', (t) => {
  const box = repo(t);
  const { board, at } = boardAt(box);
  try {
    at(HOUR / 12);
    store.register(board, { lane: 'coordinator', path: box.root });
    const builder = store.register(board, { lane: 'core', path: join(box.dir, 'review-rank') });
    const first = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Already higher priority' });
    const second = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Lower priority claimed' });
    const unrelated = store.addItem(board, { by: 'coordinator', lane: 'docs', title: 'Unrelated document' });
    store.addMilestone(board, { agentId: 'coordinator', reason: 'Fixture controls historical ordering.', name: 'review-main', items: [first, second] });
    store.orderMilestoneItems(board, 'review-main', { agentId: 'coordinator', reason: 'Fixture controls historical ordering.', items: [first, second] });
    store.addMilestone(board, { agentId: 'coordinator', reason: 'Fixture controls historical ordering.', name: 'review-other', items: [] });
    store.claim(board, second, { agentId: builder, lane: 'core', leaseMs: 2 * HOUR, freeze });
    /** Read the same actual health projection before and after an unrelated roadmap edit. */
    const inversion = () => boardHealth(box.file, { dispatchHealth, root: box.root, now: new Date(NOW) }).stuck
      .find(entry => entry.key === `RANK_INVERSION:item:${second}`);
    assert.equal(inversion()?.detail.ahead, first, 'the lower-priority claim begins as a real inversion');
    store.editMilestoneItems(board, 'review-other', { agentId: 'coordinator', reason: 'Fixture controls historical ordering.', add: [unrelated] });
    assert.equal(inversion()?.detail.ahead, first,
      'editing a different milestone cannot erase an unchanged claim-time inversion');
    store.editMilestone(board, 'review-other', { agentId: 'coordinator', reason: 'Fixture controls historical ordering.', note: 'Unrelated note changed' });
    assert.equal(inversion()?.detail.ahead, first,
      'a note edit on a different milestone cannot erase the same proven inversion');
  } finally { store.closeBoard(board); }
});

test('rejected higher work is free before a lower claim [N2,B13]', (t) => {
  const box = repo(t);
  const { board, at } = boardAt(box);
  try {
    at(HOUR);
    store.register(board, { lane: 'coordinator', path: box.root });
    const firstBuilder = store.register(board, { lane: 'core', path: join(box.dir, 'review-first') });
    const builder = store.register(board, { lane: 'core', path: join(box.dir, 'review-second') });
    const reviewer = store.register(board, { lane: 'review', path: join(box.dir, 'review-verifier') });
    const first = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Higher rejected work' });
    const second = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Lower fresh work' });
    const commit = box.git(['rev-parse', 'HEAD']);
    store.claim(board, first, { agentId: firstBuilder, lane: 'core', leaseMs: 2 * HOUR, freeze });
    submitFixture(board, first, { agentId: firstBuilder, commit, tree: 'fixture-tree' });
    store.verify(board, first, { agentId: reviewer, decision: 'REJECT', reason: 'TEST_FAILURE',
      clause: 'Higher rejected work', note: 'Fixture review returns higher work to open', head: commit, digest: 'digest:Higher rejected work', policy: 'any' });
    assert.equal(store.getItem(board, first).item_status, 'open', 'the reject really frees the higher item');
    at(HOUR / 12);
    store.claim(board, second, { agentId: builder, lane: 'core', leaseMs: 2 * HOUR, freeze });
    const inversion = boardHealth(box.file, { dispatchHealth, root: box.root, now: new Date(NOW) }).stuck
      .find(entry => entry.key === `RANK_INVERSION:item:${second}`);
    assert.equal(inversion?.detail.ahead, first, 'higher work was already open and ranked when lower work was claimed');
  } finally { store.closeBoard(board); }
});
