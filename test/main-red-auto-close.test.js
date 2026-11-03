/** Main red auto-close requires exact frozen named checks and per-file green proof at current main [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureGit } from './fixture-child.js';
import { board as store, closeBoard, openBoard, openBoardForRead } from '../apps/lib/index.js';
import { closeAuditedMainReds, mainRedCheckFiles, mainRedFilesProven, mainRedFrozenCheck } from '../packages/gate/index.js';
import { createHash } from 'node:crypto';

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
  assert.deepEqual(mainRedCheckFiles('node bin/run-tests.js test/a.test.js test/b.test.js'), ['test/a.test.js', 'test/b.test.js']);
  assert.deepEqual(mainRedCheckFiles('node --test test/a.test.js'), ['test/a.test.js']);
  for (const check of ['node bin/run-tests.js --test test/a.test.js', 'node --test --test-reporter=tap test/a.test.js',
    'node --test test/a.test.js && true', 'node  --test test/a.test.js', 'node --test test/../outside.test.js',
    'node --test test/a.test.js test/a.test.js', 'node bin/run-tests.js']) assert.equal(mainRedCheckFiles(check), null, check);
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
});

test('the main audit withdraws only a named-file green Main red and records its source fact [C7]', async t => {
  const scratch = mkdtempSync(join(tmpdir(), 'pullboard main-red auto-close '));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const repo = join(scratch, 'repo');
  mkdirSync(join(repo, 'test'), { recursive: true });
  writeFileSync(join(repo, 'test/a.test.js'), '');
  writeFileSync(join(repo, 'test/b.test.js'), '');
  fixtureGit(repo, 'init', '-q', '-b', 'main');
  fixtureGit(repo, 'add', '-A');
  fixtureGit(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'fixture');
  const tip = fixtureGit(repo, 'rev-parse', 'HEAD');
  const tree = fixtureGit(repo, 'rev-parse', 'HEAD^{tree}');
  const dbFile = join(repo, '.git/pullboard/board.sqlite');
  const db = openBoard(dbFile, undefined, { isMain: true, gitRoot: repo });
  t.after(() => closeBoard(db));
  store.register(db, { lane: 'coordinator', path: repo });
  function add(title, check) {
    const id = store.addItem(db, { by: 'coordinator', lane: 'core', title, criterion: 'The named file passes.', check });
    const frozen = JSON.stringify({ title, criterion: 'The named file passes.', check, rows: [] });
    db.db.prepare('UPDATE item SET item_frozen=?, item_frozen_digest=? WHERE item_id=?')
      .run(frozen, createHash('sha256').update(frozen).digest('hex'), id);
    return id;
  }
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
  const scratch = mkdtempSync(join(tmpdir(), 'pullboard main-red race '));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const repo = join(scratch, 'repo');
  mkdirSync(repo);
  fixtureGit(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'tracked'), 'fixture');
  fixtureGit(repo, 'add', '-A');
  fixtureGit(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'fixture');
  const db = openBoard(join(repo, '.git/pullboard/board.sqlite'), undefined, { isMain: true, gitRoot: repo });
  t.after(() => closeBoard(db));
  store.register(db, { lane: 'coordinator', path: repo });
  const title = 'Main red: changed during audit';
  const check = 'node --test test/a.test.js';
  const id = store.addItem(db, { by: 'coordinator', lane: 'core', title, criterion: 'The named file passes.', check });
  const oldFrozen = JSON.stringify({ title, criterion: 'The named file passes.', check, rows: [] });
  const oldDigest = createHash('sha256').update(oldFrozen).digest('hex');
  const newFrozen = JSON.stringify({ title, criterion: 'The named file passes.', check: 'node --test test/b.test.js', rows: [] });
  const newDigest = createHash('sha256').update(newFrozen).digest('hex');
  db.db.prepare('UPDATE item SET item_frozen=?, item_frozen_digest=? WHERE item_id=?').run(newFrozen, newDigest, id);
  assert.throws(() => store.withdraw(db, id, { agentId: 'coordinator', reason: 'audit passed the old bar',
    expected: { status: 'open', title, check, frozenDigest: oldDigest } }), error => error.code === 'STALE_MAIN_RED');
  assert.equal(store.getItem(db, id).item_status, 'open');
});
