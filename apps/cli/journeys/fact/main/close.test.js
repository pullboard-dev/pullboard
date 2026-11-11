/** Main red auto-close requires exact frozen named checks and per-file green proof at current main [C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureGit } from '../../../tests/fixtures/child.js';
import { fixtureProjectPolicy } from '../../../tests/fixtures/testkit.js';
import {
  board as store,
  closeBoard,
  openBoard,
  openBoardForRead,
} from '../../../../lib/index.js';
import {
  closeAuditedMainReds,
  mainRedCheckFiles,
  mainRedFilesProven,
  mainRedFrozenCheck,
  withAuditedMain,
} from '../../../../../packages/gate/index.js';
import { withOpenedBoard } from '../../../index.js';
import { repoInfo } from '../../../../../packages/git/index.js';
import { minimumMoveEngine } from '../../../../../packages/moves/index.js';
import {
  applyEngineMove,
  prepareEngineMove,
} from '../../../../../packages/state/index.js';
import { createHash } from 'node:crypto';
import { passingMainReds } from '../../../../../packages/landing/index.js';
import { turnedGreenAt } from '../../../../../packages/landing/index.js';

const head = 'a'.repeat(40);
const proof = {
  plan: { keys: { 'test/a.test.js': 'c'.repeat(64), 'test/b.test.js': 'd'.repeat(64) } },
  receipt: { head, tree: 'b'.repeat(40), collection: { complete: true, files: ['test/a.test.js', 'test/b.test.js'] },
    testOutcomes: [{ file: 'test/a.test.js', passed: true }, { file: 'test/b.test.js', passed: true }], failures: [] },
  auditedHead: head, currentHead: head, auditedTree: 'b'.repeat(40), currentTree: 'b'.repeat(40),
};
proof.plan.run = ['test/a.test.js', 'test/b.test.js'];
proof.plan.reused = [];

/** Isolate temporary Git repositories from runner checkout variables and user-wide config. */
function fixtureGit(cwd, ...args) {
  const env = {
    ...process.env,
    GIT_CONFIG_COUNT: '0',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[name];
  return runFixtureGit(args, { cwd, env });
}

test('only the two exact named-file Node check forms are eligible [C7]', () => {
  assert.deepEqual(mainRedCheckFiles('node packages/gate/src/io/run/tests.js test/a.test.js test/b.test.js'), ['test/a.test.js', 'test/b.test.js']);
  assert.deepEqual(mainRedCheckFiles('node --test test/a.test.js'), ['test/a.test.js']);
  for (const check of ['node packages/gate/src/io/run/tests.js --test test/a.test.js', 'node --test --test-reporter=tap test/a.test.js',
    'node --test test/a.test.js && true', 'node  --test test/a.test.js', 'node --test test/../outside.test.js',
    'node --test test/a.test.js test/a.test.js', 'node packages/gate/src/io/run/tests.js']) assert.equal(mainRedCheckFiles(check), null, check);
});

test('the check comes from a digest-matching frozen bar, never the mutable check field [C7]', () => {
  const item = { item_title: 'Main red: fixture', item_check: 'node --test test/mutable.test.js',
    item_frozen: JSON.stringify({ title: 'Main red: fixture', check: 'node --test test/frozen.test.js' }) };
  item.item_frozen_digest = createHash('sha256').update(item.item_frozen).digest('hex');
  assert.equal(mainRedFrozenCheck(item), 'node --test test/frozen.test.js');
  assert.equal(mainRedFrozenCheck({ ...item, item_frozen_digest: '0'.repeat(64) }), null, 'a stale frozen digest is not trusted');
});

test('named green files qualify on the exact audited current main tip even when another audit file failed [C7]', () => {
  const redElsewhere = { ...proof, receipt: { ...proof.receipt,
    failures: [{ file: 'test/elsewhere.test.js', name: 'broken elsewhere' }] } };
  assert.equal(mainRedFilesProven('node --test test/a.test.js test/b.test.js', redElsewhere), true);
  assert.equal(mainRedFilesProven('node --test test/a.test.js test/missing.test.js', proof), false, 'missing plan key is not proof');
  assert.equal(mainRedFilesProven('node --test test/a.test.js', { ...proof, currentHead: 'c'.repeat(40) }), false, 'stale audit tip is not proof');
  assert.equal(mainRedFilesProven('node --test test/a.test.js', { ...proof, currentTree: 'c'.repeat(40) }), false, 'stale tree is not proof');
  assert.equal(mainRedFilesProven('node --test test/a.test.js', { ...proof,
    receipt: { ...proof.receipt, testOutcomes: [{ file: 'test/a.test.js', passed: false }] } }), false, 'a failed named file remains open');
  assert.equal(mainRedFilesProven('node --test test/a.test.js', { ...proof,
    receipt: { ...proof.receipt, testOutcomes: [] } }), false, 'missing per-file outcomes are not inferred');
  assert.equal(mainRedFilesProven('node --test test/a.test.js', { ...proof,
    receipt: { ...proof.receipt, testOutcomes: [{ file: 'test/a.test.js', passed: true, skipped: true }] } }), false, 'skipped assertions are not green execution proof');
});

/** Create a current-policy private audit board with frozen named-file items. */
function auditFixture(t) {
  const scratch = mkdtempSync(join(tmpdir(), 'pullboard main-red auto-close '));
  let db;
  t.after(() => { if (db) closeBoard(db); rmSync(scratch, { recursive: true, force: true }); });
  const repo = join(scratch, 'repo');
  mkdirSync(join(repo, 'test'), { recursive: true });
  writeFileSync(join(repo, 'test/a.test.js'), '');
  writeFileSync(join(repo, 'test/b.test.js'), '');
  fixtureProjectPolicy(repo, {
    config: { gate: 'true', lanes: { core: { owns: ['test/'] } } },
    spec: '# Audit fixture\n## G\n- G1 [approved, must] The fixture keeps its proof. | gate: true\n',
  });
  fixtureGit(repo, 'init', '-q', '-b', 'main');
  fixtureGit(repo, 'add', '-A');
  fixtureGit(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'fixture');
  const tip = fixtureGit(repo, 'rev-parse', 'HEAD');
  const tree = fixtureGit(repo, 'rev-parse', 'HEAD^{tree}');
  const dbFile = join(repo, '.git/pullboard/board.sqlite');
  db = openBoard(dbFile, undefined, { isMain: true, gitRoot: repo });
  store.register(db, { lane: 'coordinator', path: repo });
  /** Give a private Main red a real frozen named-file bar without claiming a gate ran. */
  function add(title, check) {
    const id = store.addItem(db, { by: 'coordinator', lane: 'core', title, criterion: 'The named file passes.', check,
      route: 'strong', brief: 'Files: test/a.test.js\nTest: the current native audit proves the named file.' });
    const frozen = JSON.stringify({ title, criterion: 'The named file passes.', check, rows: [] });
    db.db.prepare('UPDATE item SET item_frozen=?, item_frozen_digest=? WHERE item_id=?')
      .run(frozen, createHash('sha256').update(frozen).digest('hex'), id);
    return id;
  }
  return { repo, db, tip, tree, add };
}

test('the main audit withdraws only a named-file green Main red and records its source fact [C7]', async t => {
  const { repo, db, tip, tree, add } = auditFixture(t);
  const passing = add('Main red: passing named file', 'node --test test/a.test.js');
  // The board lists newest first, so this failing repair is visited before the eligible green repair.
  const failing = add('Main red: failing named file', 'node --test test/b.test.js');
  const compound = add('Main red: compound check', 'node --test test/a.test.js && true');
  assert.deepEqual(store.listItems(db).filter(item => item.item_title.startsWith('Main red:')).map(item => item.item_id),
    [compound, failing, passing], 'the ineligible compound then failing item are visited before the green item');
  const plan = { keys: { 'test/a.test.js': 'c'.repeat(64), 'test/b.test.js': 'd'.repeat(64) }, run: ['test/a.test.js', 'test/b.test.js'], reused: [] };
  const receipt = { head: tip, tree, collection: { complete: true, files: ['test/a.test.js', 'test/b.test.js'] },
    testOutcomes: [{ file: 'test/a.test.js', passed: true }, { file: 'test/b.test.js', passed: false }],
    failures: [{ file: 'test/b.test.js', name: 'b fails' }] };
  const write = async (operation, args) => store[operation](db, ...args);
  assert.equal(await closeAuditedMainReds(repo, { tip, tree }, plan, receipt, write, openBoardForRead), 1);
  assert.equal(store.getItem(db, passing).item_status, 'withdrawn');
  assert.equal(store.getItem(db, failing).item_status, 'open');
  assert.equal(store.getItem(db, compound).item_status, 'open');
  assert.ok(store.itemThread(db, passing).some(entry => entry.type === 'fact'
    && entry.text.includes(`Fixed on main by ${tip}`)), 'the withdrawal has a source-bound fact');
});

test('withdraw refuses when the frozen check or digest changed after the audit snapshot [C7]', t => {
  const { repo, db } = auditFixture(t);
  const title = 'Main red: changed during audit';
  const check = 'node --test test/a.test.js';
  const id = store.addItem(db, { by: 'coordinator', lane: 'core', title, criterion: 'The named file passes.', check,
    route: 'strong', brief: 'Files: test/a.test.js\nTest: stale captured bars cannot withdraw the item.' });
  const oldFrozen = JSON.stringify({ title, criterion: 'The named file passes.', check, rows: [] });
  const oldDigest = createHash('sha256').update(oldFrozen).digest('hex');
  const newFrozen = JSON.stringify({ title, criterion: 'The named file passes.', check: 'node --test test/b.test.js', rows: [] });
  const newDigest = createHash('sha256').update(newFrozen).digest('hex');
  db.db.prepare('UPDATE item SET item_frozen=?, item_frozen_digest=? WHERE item_id=?').run(newFrozen, newDigest, id);
  const audited = { agentId: 'coordinator', reason: 'audit passed the old bar',
    expected: { status: 'open', title, check, frozenDigest: oldDigest, head } };
  const prepared = prepareEngineMove(db, 'withdraw', [id, audited]);
  const floor = minimumMoveEngine('withdraw', [id, audited], db);
  assert.ok(prepared.engine >= floor);
  assert.throws(() => applyEngineMove(db, { ...prepared, engine: floor - 1 },
    { sequence: 1, at: '2026-11-03T00:00:00.000Z' }), { code: 'RELAY_MOVE' });
  assert.equal(store.getItem(db, id).item_status, 'open', 'the lower-engine replay leaves the row unchanged');
  assert.throws(() => store.withdraw(db, id, { agentId: 'coordinator', reason: 'audit passed the old bar',
    expected: { status: 'open', title, check, frozenDigest: oldDigest, head } }), error => error.code === 'STALE_MAIN_RED');
  assert.equal(store.getItem(db, id).item_status, 'open');
  const legacy = prepareEngineMove(db, 'withdraw', [id, { agentId: 'coordinator', reason: 'legacy withdraw' }], { id: 'legacy-withdraw-without-cas' });
  assert.equal(minimumMoveEngine('withdraw', legacy.args, db), 1, 'ordinary withdrawals retain their historical replay floor');
  assert.equal(applyEngineMove(db, { ...legacy, engine: 1 }, { sequence: 1, at: '2026-11-03T00:01:00.000Z' }).error, undefined);
  assert.equal(store.getItem(db, id).item_status, 'withdrawn');
});

test('an audit withdrawal rolls back with its required source fact if recording that fact fails [C7]', t => {
  const { db, tip, add } = auditFixture(t);
  const id = add('Main red: keep atomic cause', 'node --test test/a.test.js');
  const item = store.getItem(db, id);
  const before = store.events(db, { itemId: id });
  db.db.exec("CREATE TEMP TRIGGER reject_audit_fact BEFORE INSERT ON event WHEN NEW.event_kind='fact' BEGIN SELECT RAISE(ABORT, 'fixture source fact failed'); END");
  assert.throws(() => store.withdraw(db, id, { agentId: 'coordinator', reason: 'audit is green',
    expected: { status: 'open', title: item.item_title, check: item.item_check,
      frozenDigest: item.item_frozen_digest, head: tip } }), /fixture source fact failed/u);
  assert.equal(store.getItem(db, id).item_status, 'open');
  assert.deepEqual(store.events(db, { itemId: id }), before, 'neither the withdrawal nor its fact commits alone');
});

test('native audit admission refuses a main move while its withdrawal waits, without reading Git in replay [C7]', async t => {
  const { repo, db, tip, add } = auditFixture(t);
  const id = add('Main red: queued trunk race', 'node --test test/a.test.js');
  const item = store.getItem(db, id);
  const expected = { status: 'open', title: item.item_title, check: item.item_check, frozenDigest: item.item_frozen_digest, head: tip };
  const ctx = { info: repoInfo(repo), io: {} };
  const writer = openBoard(join(repo, '.git/pullboard/board.sqlite'), undefined, { isMain: true, gitRoot: repo });
  await assert.rejects(withOpenedBoard(ctx, board => withAuditedMain(repo, board, expected, async () => {
    fixtureGit(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'queued main moved');
    store.withdraw(board, id, { agentId: 'coordinator', reason: 'old audit is green', expected });
  }), writer), error => error.code === 'STALE_MAIN_RED');
  assert.equal(store.getItem(db, id).item_status, 'open');
  assert.equal(store.events(db, { itemId: id }).some(event => ['withdraw', 'fact'].includes(event.event_kind)), false);
});

test('the existing native policy witness rolls back a main move after audit withdrawal admission [C7]', async t => {
  const { repo, db, tip, add } = auditFixture(t);
  const id = add('Main red: admitted trunk race', 'node --test test/a.test.js');
  const item = store.getItem(db, id);
  const expected = { status: 'open', title: item.item_title, check: item.item_check, frozenDigest: item.item_frozen_digest, head: tip };
  const ctx = { info: repoInfo(repo), io: {} };
  const writer = openBoard(join(repo, '.git/pullboard/board.sqlite'), undefined, { isMain: true, gitRoot: repo });
  await assert.rejects(withOpenedBoard(ctx, board => withAuditedMain(repo, board, expected, () => store.atomic(board, () => {
    store.withdraw(board, id, { agentId: 'coordinator', reason: 'audit was green at admission', expected });
    fixtureGit(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'admitted main moved');
  })), writer), error => error.code === 'POLICY_SNAPSHOT_STALE');
  assert.equal(store.getItem(db, id).item_status, 'open');
  assert.equal(store.events(db, { itemId: id }).some(event => ['withdraw', 'fact'].includes(event.event_kind)), false);
});

test('clause 1: a Main red item whose file turned green names the landing that turned it green [C7]', () => {
  const [a, b, c] = ['a', 'b', 'c'].map(ch => ch.repeat(40));
  const content = 'd'.repeat(40);
  const file = 'test/x.test.js';
  // The cache also stores each result under a content key; it is no commit and must never be named as the landing.
  const entries = { [a]: { [file]: { result: 'red', failures: [{ name: 'x case' }] } }, [content]: { [file]: { result: 'green' } },
    [b]: { [file]: { result: 'green' } }, [c]: { [file]: { result: 'green', receiptId: 'run-9' } } };
  const item = { item_id: 7, item_status: 'open', item_title: `Main red: ${file}` };
  const rows = passingMainReds([item], c, entries, [c, b, a]);
  assert.deepEqual(rows.map(row => [row.item, row.main, row.turnedGreen]), [[7, c, b]]);
  assert.equal(turnedGreenAt(entries, c, file, [c, b, a]), b);
  assert.equal(turnedGreenAt(entries, c, file, [c]), c, 'a lineage without older commits names main itself');
});

test('clause 2: a Main red item whose file is still red on main stays open [C7]', () => {
  const a = 'a'.repeat(40);
  const file = 'test/x.test.js';
  const item = { item_id: 7, item_status: 'open', item_title: `Main red: ${file}` };
  assert.deepEqual(passingMainReds([item], a, { [a]: { [file]: { result: 'red', failures: [{ name: 'x case' }] } } }), []);
  assert.deepEqual(passingMainReds([item], a, {}), []);
});

test('clause 2: a file red only on cases other than the item\'s named failures keeps the item open [C7]', () => {
  const a = 'a'.repeat(40);
  const file = 'test/x.test.js';
  const item = { item_id: 7, item_status: 'open', item_title: `Main red: ${file}`,
    item_check_baseline: { testEvidence: { failedCases: [{ file, name: 'old case' }] } } };
  const entries = { [a]: { [file]: { result: 'red', failures: [{ name: 'different case' }] } } };
  assert.deepEqual(passingMainReds([item], a, entries), []);
});
