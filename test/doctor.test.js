/** Integrity checks use throwaway git repositories and real board databases (A6). */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
const sandboxes = [];

after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

/**
 * Create a committed repo with a board and isolated git identity for one integrity scenario.
 */
function boardBox({ initialize = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-doctor-'));
  sandboxes.push(dir);
  const root = join(dir, 'repo');
  mkdirSync(root);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Doctor Test',
    GIT_AUTHOR_EMAIL: 'doctor@example.com',
    GIT_COMMITTER_NAME: 'Doctor Test',
    GIT_COMMITTER_EMAIL: 'doctor@example.com',
  };
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: root, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'true', lanes: {} }, null, 2));
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: setup');
  const dbFile = join(root, '.git', 'pullboard', 'board.sqlite');
  if (initialize) assert.equal(run('status').status, 0);
  else mkdirSync(join(root, '.git', 'pullboard'), { recursive: true });
  return { dir, root, env, git, run, dbFile };
}

/**
 * Open the test board directly so a fixture can model corruption that normal triggers prevent.
 */
function mutate(box, action) {
  const db = new DatabaseSync(box.dbFile);
  try {
    action(db);
  } finally {
    db.close();
  }
}

/**
 * Add a valid open row, then return its integer id for a corruption test.
 */
function addItem(box) {
  let id;
  mutate(box, (db) => {
    db.prepare('INSERT INTO item (item_lane, item_title, item_created_by, item_created_at, item_updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('web', 'Doctor fixture', 'coordinator', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z');
    id = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
  });
  return id;
}

test('doctor reports a clean board in one line and leaves it unchanged [A6]', () => {
  const box = boardBox();
  const before = readFileSync(box.dbFile);
  const result = box.run('doctor');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'board is clean\n');
  assert.equal(result.stderr, '');
  assert.deepEqual(readFileSync(box.dbFile), before);
});

test('doctor finds a missing lifecycle trigger without reinstalling it [A6]', () => {
  const box = boardBox();
  mutate(box, (db) => db.exec('DROP TRIGGER machine_item_start'));
  const result = box.run('doctor');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /machine_item_start is missing; repair: run pullboard status/);
  const db = new DatabaseSync(box.dbFile, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name='machine_item_start'").get().n, 0);
  } finally {
    db.close();
  }
});

test('doctor reports every required field missing from an item state [A6]', () => {
  const box = boardBox();
  const id = addItem(box);
  mutate(box, (db) => {
    db.exec('DROP TRIGGER machine_item_move; DROP TRIGGER machine_fields_claimed');
    db.prepare("UPDATE item SET item_status='claimed', item_owner='', item_lease_until='', item_frozen_digest='' WHERE item_id=?").run(id);
  });
  const result = box.run('doctor');
  assert.equal(result.status, 1);
  assert.match(result.stdout, new RegExp(`item #${id} \\(claimed\\) is missing item_owner, item_lease_until, item_frozen_digest`));
  assert.match(result.stdout, /restore a consistent board backup, then run pullboard doctor/);
});

test('doctor reports a submitted item whose git pin is gone [A6]', () => {
  const box = boardBox();
  const id = addItem(box);
  const verifiedId = addItem(box);
  writeFileSync(join(box.root, 'proof.txt'), 'commit for the submitted item\n');
  box.git('add', '-A');
  box.git('commit', '-q', '-m', 'docs: make a fixture commit');
  const commit = box.git('rev-parse', 'HEAD');
  mutate(box, (db) => {
    db.exec('DROP TRIGGER machine_item_move; DROP TRIGGER machine_fields_submitted; DROP TRIGGER machine_fields_verified; DROP TRIGGER machine_proof_verified');
    db.prepare("UPDATE item SET item_status='submitted', item_built_by='web-1', item_commit=?, item_frozen_digest='fixture-digest' WHERE item_id=?").run(commit, id);
    db.prepare("UPDATE item SET item_status='verified', item_verified_by='review-1', item_commit=? WHERE item_id=?").run(commit, verifiedId);
  });
  const result = box.run('doctor');
  assert.equal(result.status, 1);
  assert.match(result.stdout, new RegExp(`item #${id} has no pin for ${commit}`));
  assert.match(result.stdout, new RegExp(`git update-ref refs/pullboard/items/${id}/${commit.slice(0, 12)} ${commit}`));
  assert.match(result.stdout, new RegExp(`item #${verifiedId} has no pin for ${commit}`));
});

test('doctor reports verdicts whose commit object is gone [A6]', () => {
  const box = boardBox();
  const id = addItem(box);
  const missing = 'f'.repeat(40);
  mutate(box, (db) => {
    db.prepare(`INSERT INTO verdict (item_id, verdict_by, verdict_decision, verdict_reason, verdict_note,
      verdict_commit, verdict_digest, verdict_head, verdict_at) VALUES (?, 'review-1', 'REJECT', 'OTHER', 'fixture', ?, 'digest', 'head', '2026-10-07T00:00:00.000Z')`)
      .run(id, missing);
  });
  const result = box.run('doctor');
  assert.equal(result.status, 1);
  assert.match(result.stdout, new RegExp(`verdict #1 for item #${id} names missing commit ${missing}`));
  assert.match(result.stdout, new RegExp(`git update-ref refs/pullboard/items/${id}/${missing.slice(0, 12)} ${missing}`));
});

test('doctor reports older and newer schema versions without migrating either [A6]', () => {
  const box = boardBox();
  mutate(box, (db) => db.exec('PRAGMA user_version = 0'));
  const older = box.run('doctor');
  assert.equal(older.status, 1);
  assert.match(older.stdout, /schema version is 0; this pullboard expects 1; repair: run pullboard status to upgrade this board/);
  mutate(box, (db) => db.exec('PRAGMA user_version = 2'));
  const newer = box.run('doctor');
  assert.equal(newer.status, 1);
  assert.match(newer.stdout, /schema version is 2; this pullboard expects 1; repair: use a pullboard version that supports this board schema/);
  const db = new DatabaseSync(box.dbFile, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  } finally {
    db.close();
  }
});

test('doctor reports an older empty SQLite layout without querying current tables [A6]', () => {
  const box = boardBox({ initialize: false });
  const db = new DatabaseSync(box.dbFile);
  db.exec('PRAGMA user_version = 0');
  db.close();
  const before = readFileSync(box.dbFile);
  const result = box.run('doctor');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /schema version is 0; this pullboard expects 1; repair: run pullboard status to upgrade this board/);
  assert.doesNotMatch(result.stderr, /no such table|SQLITE_ERROR|Error:/);
  assert.deepEqual(readFileSync(box.dbFile), before);
});
