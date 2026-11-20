/** The thin show door returns the full path's facts for a plain item, steps aside for any other, and loads none of the board barrel [C7,#12412]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { openKitBoard } from '../../fixtures/board.js';
import { fixtureAdd } from '../../fixtures/testkit.js';
import { closeBoard } from '../../../../../packages/store/index.js';
import { declareItemField } from '../../../../../packages/store/index.js';
import { events } from '../../../../../packages/store/index.js';
import { listAgents } from '../../../../../packages/store/index.js';
import { ReadNeedsWrite } from '../../../../../packages/store/index.js';
import { thinShowFacts } from '../../../src/io/show/thin.js';

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const PRELOAD = fileURLToPath(new URL('../../../journeys/imports/count.js', import.meta.url));
const DOOR = fileURLToPath(new URL('../../../src/io/show/thin.js', import.meta.url));
/** The board barrel and its door: what the full show path loads through apps/cli/src/io/ports/process.js. */
const BARREL = ['packages/board/index.js', 'apps/lib/light.js'];
const NOW = '2026-11-20T00:00:00.000Z';

/** A project holding `count` plain items, #1 on, that nobody has touched beyond adding them. */
async function plainProject(t, count = 1) {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project();
  for (let n = 1; n <= count; n++) {
    const added = await fixtureAdd(box.runLocal, box.repo, 'web', `Thin show item ${n}`);
    assert.equal(added.code, 0, added.err);
  }
  return box;
}

/** Run `work` on the project's board, opened for writing the way the fixtures do, and close it. */
function onBoard(box, work) {
  const board = openKitBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try { return work(board); } finally { closeBoard(board); }
}

test('cli.io-show-thin.plain-item-facts: clause 1: thinShowFacts returns { item, agents, history } equal to the rows the full show reads for a plain item [C7]', async (t) => {
  const box = await plainProject(t);
  const full = await box.runLocal(box.repo, 'show', '1', '--json');
  assert.equal(full.code, 0, full.err);
  const shown = JSON.parse(full.out);
  const thin = await thinShowFacts({ cwd: box.repo, id: 1 });
  assert.ok(thin, 'the door served a plain item on a current board');
  assert.deepEqual(Object.keys(thin).sort(), ['agents', 'history', 'item']);
  assert.equal(thin.item.item_id, 1);
  for (const [key, value] of Object.entries(JSON.parse(JSON.stringify(thin.item)))) assert.deepEqual(shown[key], value, `item.${key} is what the full show prints`);
  const expected = onBoard(box, board => ({ agents: listAgents(board), history: events(board, { itemId: 1 }) }));
  assert.deepEqual(JSON.parse(JSON.stringify(thin.agents)), JSON.parse(JSON.stringify(expected.agents)));
  assert.deepEqual(JSON.parse(JSON.stringify(thin.history)), JSON.parse(JSON.stringify(expected.history)));
});

/** Prove the door serves item `id`, put a row on the board that makes the full show read a heavy section for it, and prove the door now steps aside: the row alone made it. Events only ever append, so each case has its own item. */
async function stepsAsideFor(box, name, id, add) {
  assert.ok(await thinShowFacts({ cwd: box.repo, id }), `${name}: the door serves the item before the row`);
  onBoard(box, board => add(board.db, id));
  assert.equal(await thinShowFacts({ cwd: box.repo, id }), null, `${name}: the door steps aside`);
}

test('cli.io-show-thin.steps-aside: clause 2: thinShowFacts returns null for no readable board, a drifted board, a receipt, a refusal, a thread entry, a typed field, an after-gate list, a submit, a foreign wait, and a ReadNeedsWrite or schemaMissing error [C7]', async (t) => {
  const box = await plainProject(t, 9);
  const bare = join(box.dir, 'bare');
  mkdirSync(bare);
  box.git(bare, 'init', '-q', '-b', 'main');
  assert.equal(await thinShowFacts({ cwd: bare, id: 1 }), null, 'no readable board');
  assert.equal(await thinShowFacts({ cwd: box.repo, id: 99 }), null, 'no such item');
  const event = (kind, detail = '{}') => (db, id) => db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)').run(NOW, 'fixture', kind, id, detail);
  await stepsAsideFor(box, 'a receipt', 1, event('proof-run', JSON.stringify({ receipt: { run: 'fixture-run' } })));
  await stepsAsideFor(box, 'a refusal', 2, event('reject'));
  await stepsAsideFor(box, 'a thread entry', 3, event('fact', JSON.stringify({ text: 'a fixture fact' })));
  await stepsAsideFor(box, 'a submit', 4, event('submit'));
  await stepsAsideFor(box, 'an after-gate list', 5, (db, id) => db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(`after_gate:${id}`, '[2]'));
  await stepsAsideFor(box, 'a foreign wait', 6, (db, id) => db.prepare('UPDATE item SET item_after = ? WHERE item_id = ?').run('other-repo#7', id));
  // An accepted item loads the merge index's reader; a reader the read cannot serve sends the call to the full path.
  // A status moves only inside a move, which the board marks in its temp.moving table; the fixture marks it the same way for this one row.
  onBoard(box, board => {
    board.db.exec('INSERT INTO temp.moving (token) VALUES (1)');
    try { board.db.prepare("UPDATE item SET item_status = 'verified' WHERE item_id = 9").run(); } finally { board.db.exec('DELETE FROM temp.moving'); }
  });
  assert.equal(await thinShowFacts({ cwd: box.repo, id: 9, conflictReader: async () => { throw new ReadNeedsWrite('fixture write'); } }), null, 'ReadNeedsWrite');
  assert.equal(await thinShowFacts({ cwd: box.repo, id: 9, conflictReader: async () => { throw new Error('no such table: fixture_missing'); } }), null, 'schemaMissing');
  // The field tables join the board last: the item that holds no value is still served, so the item that holds one steps aside for its value alone.
  onBoard(box, board => declareItemField(board, { by: 'fixture', name: 'size', type: 'text', enabled: true }));
  await stepsAsideFor(box, 'a typed field', 7, (db, id) => db.prepare("INSERT INTO item_field (item_id, field_name, field_value, field_set_by, field_set_at) VALUES (?, 'size', 'small', 'fixture', ?)").run(id, NOW));
  assert.ok(await thinShowFacts({ cwd: box.repo, id: 8 }), 'an item with no field value is still served');
});

test('cli.io-show-thin.steps-aside-drifted-board: clause 2: thinShowFacts returns null for a board whose shape drifted [C7]', async (t) => {
  const box = await plainProject(t);
  assert.ok(await thinShowFacts({ cwd: box.repo, id: 1 }), 'the board is current before it drifts');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try { db.exec('CREATE TABLE fixture_drift (x INTEGER)'); } finally { db.close(); }
  assert.equal(await thinShowFacts({ cwd: box.repo, id: 1 }), null);
});

/** Load the door in a fresh worker thread with count.js recording every file the thread loads: a thread, not a process, so no launch is paid. */
function loadedByDoor(countFile) {
  const code = `const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.preload).then(() => import(workerData.door)).then(() => parentPort.postMessage('loaded'), (error) => parentPort.postMessage(String(error?.stack ?? error)));`;
  return new Promise((resolve, reject) => {
    const worker = new Worker(code, { eval: true, env: { ...process.env, PULLBOARD_COUNT_FILE: countFile }, workerData: { preload: pathToFileURL(PRELOAD).href, door: pathToFileURL(DOOR).href } });
    worker.once('message', (message) => { void worker.terminate(); resolve(message); });
    worker.once('error', reject);
  });
}

test('cli.io-show-thin.loads-no-barrel: clause 3: a worker that imports only the thin show door loads none of the board barrel modules [C7]', async () => {
  const files = privateFixtureFiles('thin-show-');
  files.write('seen.txt', '');
  assert.equal(await loadedByDoor(`${files.root}/seen.txt`), 'loaded');
  const seen = files.read('seen.txt').toString('utf8').split('\n').filter(Boolean).map(url => fileURLToPath(url).slice(ROOT.length));
  assert.ok(seen.some(path => path.endsWith('apps/cli/src/io/show/thin.js')), 'the door itself loaded');
  assert.deepEqual(seen.filter(path => BARREL.includes(path) || path.startsWith('packages/board/')), []);
});
