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

test('an ordinary candidate\'s remote cell request carries only cut rows and stays under the runner limit [C7,V4]', async t => {
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
