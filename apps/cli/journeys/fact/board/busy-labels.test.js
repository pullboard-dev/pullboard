/** @pullboard-test-input apps/cli/pullboard.js apps/lib/index.js packages/git/index.js packages/store/index.js */
/** @pullboard-test-loads packages/store/src/io/board.js */
import { copyPackageFiles } from '../../../../../packages/runners/index.js';
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  join,
  resolve,
} from 'node:path';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { mappedWorkingSource } from '../../../../../packages/gate/src/io/scan.js';
import { boardWriteHolderText } from '../../../../../packages/store/index.js';
import { exportBoard } from '../../../../../packages/store/index.js';
import { beginCommandPhase } from '../../../../../packages/link/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import {
  runFixtureChild,
  startFixtureChild,
} from '../../../tests/fixtures/child.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';

// Process-level: these launches run preloads, installed copies and other-process SQLite contention, none of which an in-process call can reproduce.
const e2e = createE2eHelpers();
after(e2e.cleanup);
const BIN = resolve(import.meta.dirname, '../../../pullboard.js');

/** Snapshot the real private board without acquiring a write lock. */
function snapshot(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return exportBoard({ db }, { beginCommandPhase }); }
  finally { db.close(); }
}

/** Read only the product's structured long-write diagnostic, leaving other stderr intact. */
function longWrites(stderr) {
  return stderr.split('\n').filter(line => line.startsWith('pullboard: long board write '))
    .map(line => JSON.parse(line.slice('pullboard: long board write '.length)));
}

test('cli.journeys-fact-board-busy-labels.a-real-cli-writer-labels-its: a real CLI writer labels its long transaction without changing JSON or native counts [C7,P4,B2]', () => {
  const box = e2e.project();
  box.env.PULLBOARD_BOARD_QUEUE_MS = '0'; // These tests assert the refusal at SQLite timeout; #1854 queueing has its own test.
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const before = snapshot(file);
  const preload = join(box.dir, 'hold-private-shout.mjs');
  writeFileSync(preload, `
    import { DatabaseSync } from 'node:sqlite';
    const prepare = DatabaseSync.prototype.prepare;
    let delayed = false;
    /** Delay one actual private shout insertion after its outer transaction has acquired the lock. */
    DatabaseSync.prototype.prepare = function(sql, ...args) {
      const statement = prepare.call(this, sql, ...args);
      if (!sql.includes('INSERT INTO shout')) return statement;
      const run = statement.run;
      statement.run = function(...values) {
        if (!delayed) {
          delayed = true;
          // budget: exercise the genuine long-hold diagnostic, not a performance assertion.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_100);
        }
        return run.apply(this, values);
      };
      return statement;
    };
  `);
  // Process-level: a --import preload patches SQLite inside the CLI's own node process; argv, stderr and exit status need that real process.
  const result = runFixtureChild(process.execPath, ['--import', preload, BIN, 'shout', 'all', 'private timed shout', '--json'], {
    cwd: box.web, env: box.env, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.context);
  assert.equal(JSON.parse(result.stdout).version, 1, 'the diagnostic stays off JSON stdout');
  const records = longWrites(result.stderr);
  assert.equal(records.length, 1);
  assert.equal(records[0].command, 'shout');
  assert.equal(records[0].seat, 'web-1');
  assert.equal(records[0].outcome, 'committed');
  assert.ok(Number.isSafeInteger(records[0].pid));
  assert.ok(records[0].durationMs > 2_000); // budget: declared #1197 over-2s logging threshold.
  const after = snapshot(file);
  assert.equal(after.tables.shout.length, before.tables.shout.length + 1);
  assert.equal(after.tables.event.length, before.tables.event.length + 1);
  assert.equal(boardWriteHolderText(file), '');
});

test('cli.journeys-fact-board-busy-labels.opening-an-older-board-names-and: opening an older board names and logs its genuine index-building write [C7,P4,B2]', async (t) => {
  const box = e2e.project();
  box.env.PULLBOARD_BOARD_QUEUE_MS = '0'; // These tests assert the refusal at SQLite timeout; #1854 queueing has its own test.
  // Installed source may own a main-board migration without entering the small project's Git history.
  const installed = join(box.dir, 'installed-maintenance-cli');
  mkdirSync(installed);
  copyPackageFiles(resolve(import.meta.dirname, '../../../../..'), installed);
  const privateBin = join(installed, 'apps/cli/pullboard.js');
  assert.equal(box.git(box.repo, 'rev-parse', '--path-format=absolute', '--git-dir'),
    box.git(box.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  assert.equal(readFileSync(privateBin, 'utf8'), readFileSync(BIN, 'utf8'));
  const sourceGit = mappedWorkingSource(resolve(import.meta.dirname, '../../../../..'), 'packages/git/index.js');
  const installedGit = {
    body: readFileSync(join(installed, sourceGit.implementationPath)),
    shimBody: sourceGit.shimBody === null ? null : readFileSync(join(installed, sourceGit.shimPath)),
  };
  assert.deepEqual(installedGit.body, sourceGit.body, 'the installed implementation retains exact source Buffer bytes');
  assert.deepEqual(installedGit.shimBody, sourceGit.shimBody, 'the installed compatibility shim retains exact source bytes');
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'private maintenance item', '--specs', 'G1', '--criterion', 'the private page renders', '--json');
  assert.equal(added.code, 0, added.err);
  const id = JSON.parse(added.out).item.item_id;
  const fact = await box.runLocal(box.repo, 'fact', String(id), 'note', 'private native index input', '--json');
  assert.equal(fact.code, 0, fact.err);
  const before = snapshot(file);
  const fixture = new DatabaseSync(file);
  const indexes = fixture.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND name LIKE 'event_fact_%_v2' ORDER BY name").all();
  const version = fixture.prepare('PRAGMA user_version').get().user_version;
  const stamp = fixture.prepare('PRAGMA application_id').get().application_id;
  try {
    assert.equal(indexes.length, 3);
    for (const index of indexes) fixture.exec(`DROP INDEX "${index.name}"`);
    fixture.exec("UPDATE board_meta SET meta_value = '0' WHERE meta_key = 'event_log_version'; PRAGMA application_id = 0"); // the oldest upgradable schema is the current one, so an old event log version is the genuine pending migration
  } finally { fixture.close(); }
  const releaseFile = join(box.dir, 'release-private-index');
  const preload = join(box.dir, 'hold-private-index.mjs');
  writeFileSync(preload, `
    import { DatabaseSync } from 'node:sqlite';
    import { existsSync } from 'node:fs';
    const originalExec = DatabaseSync.prototype.exec;
    const reference = new DatabaseSync(':memory:');
    let registered = false;
    let held = false;
    /** Pause inside actual SQLite index evaluation, preserving reference SQLite JSON semantics. */
    DatabaseSync.prototype.exec = function(sql, ...args) {
      if (!registered && sql.includes('CREATE INDEX IF NOT EXISTS event_fact_identity_v2')) {
        registered = true;
        /** Preserve SQLite's extraction result while the first evaluation exercises the real lock. */
        function extractIdentity(value, path) {
          if (!held) {
            held = true;
            process.send({ kind: 'index-write-held' });
            const deadline = Date.now() + 30_000; // budget: bound cleanup of the owned private lock fixture.
            while (!existsSync(${JSON.stringify(releaseFile)})) {
              if (Date.now() >= deadline) throw new Error('private index writer was not released');
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
            }
          }
          return reference.prepare('SELECT json_extract(?, ?) AS value').get(value, path).value;
        }
        this.function('json_extract', { deterministic: true }, extractIdentity);
      }
      return originalExec.call(this, sql, ...args);
    };
  `);
  const child = startFixtureChild(process.execPath, ['--import', preload, privateBin, 'shout', 'all', 'private maintenance move', '--json'], {
    cwd: box.repo, env: box.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise(resolveClosed => child.once('close', (code, signal) => resolveClosed({ code, signal })));
  let released = false;
  /** Release and drain only the CLI this fixture owns, including on an assertion failure. */
  async function release() {
    if (!released) { released = true; writeFileSync(releaseFile, 'release\n'); }
    const result = await closed;
    assert.deepEqual(result, { code: 0, signal: null }, `${stdout}\n${stderr}`.trim() || child.fixtureFailure);
  }
  t.after(release);
  await new Promise((resolveReady, rejectReady) => {
    child.once('error', rejectReady);
    child.once('close', (code, signal) => rejectReady(new Error(`private maintenance exited before index evaluation: ${code}/${signal}: ${stdout}\n${stderr}`)));
    child.on('message', message => { if (message?.kind === 'index-write-held') resolveReady(); });
  });
  const contender = new DatabaseSync(file);
  try {
    contender.exec('PRAGMA busy_timeout = 0');
    assert.throws(() => contender.exec('BEGIN IMMEDIATE'), error => (error.errcode & 0xff) === 5,
      'index evaluation must hold the genuine SQLite write lock, not merely sleep before SQL');
  } finally { contender.close(); }
  const heldText = boardWriteHolderText(file);
  await new Promise(resolveDelay => setTimeout(resolveDelay, 2_100)); // budget: exercise the declared over-2s write diagnostic.
  await release();
  assert.equal(JSON.parse(stdout).version, 1, 'maintenance diagnostics stay off JSON stdout');
  const records = longWrites(stderr);
  assert.equal(records.length, 1, 'one real behind-schema index transaction must log its long write');
  assert.equal(records[0].command, 'shout');
  assert.equal(records[0].seat, 'coordinator');
  assert.equal(records[0].pid, child.pid);
  assert.ok(records[0].durationMs > 2_000); // budget: declared #1197 over-2s logging threshold.
  assert.ok(heldText.includes('shout') && heldText.includes('coordinator'), heldText);
  assert.equal(boardWriteHolderText(file), '');
  const after = snapshot(file);
  for (const [name, rows] of Object.entries(before.tables)) {
    if (name === 'sqlite_sequence') {
      const sequences = Object.fromEntries(rows.map(row => [row.name, row.seq]));
      for (const table of ['event', 'shout']) sequences[table] = (sequences[table] ?? 0) + 1;
      assert.deepEqual(after.tables[name].map(row => [row.name, row.seq]), Object.entries(sequences).sort());
      continue;
    }
    assert.deepEqual(after.tables[name].slice(0, rows.length), rows, `existing native ${name} rows survive maintenance`);
    assert.equal(after.tables[name].length, rows.length + (['event', 'shout'].includes(name) ? 1 : 0));
  }
  const upgraded = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, version);
    assert.equal(upgraded.prepare('PRAGMA application_id').get().application_id, stamp);
    assert.deepEqual(upgraded.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND name LIKE 'event_fact_%_v2' ORDER BY name").all(), indexes);
  } finally { upgraded.close(); }
});
