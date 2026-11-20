/** A queued submit's remote cell request stays well under the runner's 1 MiB transfer limit [C7,V4]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { landedCutItemRows } from '../../../index.js';
import { writeFileSync } from 'node:fs';
import { runnerCommand } from '../../../src/io/commands/runner.js';
import { fixtureMachineSettings } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { remoteSubmitCells } from '../../../src/io/submit/remote.js';

const LIMIT = 1024 ** 2;

/** A real SQLite board file holding a long history of ordinary landed items and a few landed cut items. */
function historyBoard(dir, ordinary) {
  const db = new DatabaseSync(join(dir, 'board.sqlite'));
  db.exec(`CREATE TABLE item (item_id INTEGER PRIMARY KEY, item_lane TEXT, item_title TEXT, item_status TEXT, item_merged_commit TEXT);
    CREATE TABLE board_meta (meta_key TEXT PRIMARY KEY, meta_value TEXT);`);
  const insert = db.prepare('INSERT INTO item VALUES (?, ?, ?, ?, ?)');
  for (let id = 1; id <= ordinary; id++) {
    insert.run(id, 'core', `feat(merge): an ordinary landed build ${id} whose long descriptive title names what it changed and why it mattered for speed`, 'verified', 'a'.repeat(40));
  }
  for (const [offset, cell] of ['kernel', 'store', 'gate'].entries()) {
    insert.run(ordinary + offset + 1, 'core', `Cells import cuts: ${cell} removes imports into later cells`, 'verified', 'b'.repeat(40));
  }
  return db;
}

/** Capture the exact request a submit hands its runner, measured as the runner spec embeds it (command and trusted mode). */
async function capturedRequest(root, readCutItems) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  const main = git('rev-parse', 'HEAD');
  let captured;
  const sentinel = new Error('captured');
  const runOnRunnerAsync = async (_root, shell, options) => { captured = { shell, privateCheck: options.privateCheck }; throw sentinel; };
  const lease = { runner: { host: 'fixture' }, source: { commit: main }, executionServices: { runners: { runOnRunnerAsync } } };
  const item = { item_frozen: JSON.stringify({ criterion: 'An ordinary candidate.' }) };
  await assert.rejects(remoteSubmitCells(root, main, main, item, lease, readCutItems, join(root, '.artifacts')), error => error === sentinel);
  return { ...captured, bytes: Buffer.byteLength(JSON.stringify({ command: captured.shell, trustedMode: captured.privateCheck })) };
}

test('cli.io-commands-runner.an-ordinary-candidate-s-remote-cell-request: an ordinary candidate\'s remote cell request carries only cut rows and stays under the runner limit [C7,V4]', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-request-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'pullboard.trunk', 'refs/heads/main']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--allow-empty', '-m', 'trusted main']);
  const db = historyBoard(dir, 4000);
  t.after(() => db.close());
  const rows = landedCutItemRows(db);
  assert.deepEqual(rows.map(row => row.item_title.split(' ')[3]), ['kernel', 'store', 'gate'], 'only cut items are read');
  const ordinary = await capturedRequest(root, () => landedCutItemRows(db));
  assert.ok(ordinary.bytes < LIMIT / 16, `the request is ${ordinary.bytes} bytes; a normal candidate stays far under ${LIMIT}`);
  // Control: the same board's full landed history, as the request carried before, crosses the limit.
  const everything = db.prepare("SELECT item_id, item_lane, item_title, item_status, item_merged_commit FROM item WHERE item_status='verified'").all();
  const bulk = await capturedRequest(root, () => everything);
  assert.ok(bulk.bytes > LIMIT, `the control request (${bulk.bytes} bytes) proves the fixture reaches the limit`);
});

const SUDO = 'sudo launchctl bootout system/dev.pullboard.runner';

/** Run work with PULLBOARD_MACHINE_HOME on a folder holding one registered runner and, when given, its install-serve record. */
async function withRunner(t, record, work) {
  const { root: home } = privateFixtureFiles('pullboard-runner-pending-');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  fixtureMachineSettings(home, { runners: [{ host: 'fixture-runner' }] });
  if (record) writeFileSync(join(home, 'runner-services.json'), JSON.stringify({ 'fixture-runner': record }));
  const before = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  try { return await work(); } finally { if (before === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = before; }
}

test('cli.io-commands-runner.list-shows-pending-removal: clause 1: runner list prints pending removal of the old service with the sudo line, and the json result carries pendingRemoval [P7]', async t => {
  await withRunner(t, { board: 'http://board.test', form: 'agent', loaded: false, sudo: SUDO, pendingRemoval: true }, async () => {
    const lines = [];
    let result;
    assert.equal(await runnerCommand({ say: line => lines.push(line), result: value => { result = value; } }, { first: 'list', rest: [], values: {} }), 0);
    const row = result.runners.find(entry => entry.host === 'fixture-runner');
    assert.equal(row.pendingRemoval, true);
    assert.equal(row.sudo, SUDO);
    assert.match(lines.join('\n'), /pending removal of old service/);
    assert.ok(lines.join('\n').includes(SUDO));
  });
  await withRunner(t, { board: 'http://board.test', form: 'agent', loaded: true }, async () => {
    const lines = [];
    let result;
    await runnerCommand({ say: line => lines.push(line), result: value => { result = value; } }, { first: 'list', rest: [], values: {} });
    assert.equal(result.runners.find(entry => entry.host === 'fixture-runner').pendingRemoval, undefined);
    assert.doesNotMatch(lines.join('\n'), /pending removal/);
  });
});

test('cli.io-commands-runner.install-serve-pending-removal-not-ready: clause 2: install-serve for a result with pendingRemoval prints NOT READY with the sudo line and returns exit 1 [P7]', async t => {
  await withRunner(t, undefined, async () => {
    const lines = [];
    const install = async runner => ({ host: runner.host, label: 'dev.pullboard.runner', form: 'agent', loaded: false, pendingRemoval: true, sudo: SUDO, plist: '/x.plist', log: '/x.log' });
    const code = await runnerCommand({ say: line => lines.push(line), result: () => {} }, { first: 'install-serve', second: 'fixture-runner', rest: [], values: { board: 'http://board.test', key: 'fixture-key' } }, { install });
    assert.equal(code, 1);
    assert.match(lines.join('\n'), /NOT READY/);
    assert.ok(lines.join('\n').includes(SUDO));
  });
});
