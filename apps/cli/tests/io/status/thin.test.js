/** @pullboard-test-input source-tree */
/** The thin status door returns null for boards it cannot serve, and status falls through to the full path with unchanged output [C7,#12743]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { openKitBoard } from '../../fixtures/board.js';
import { fixtureAdd } from '../../fixtures/testkit.js';
import { pinDerivedStateOff } from '../../fixtures/thin-door.js';
import { setReadThin } from '../../fixtures/thin-door.js';
import { closeBoard } from '../../../../../packages/store/index.js';
import { openBoardForRead } from '../../../../../packages/store/index.js';
import { ReadNeedsWrite } from '../../../../../packages/store/index.js';
import { thinStatusFacts } from '../../../src/io/status/thin.js';

const STATUS = fileURLToPath(new URL('../../../src/io/commands/status.js', import.meta.url));
const NOW = '2026-11-21T00:00:00.000Z';

/** A project holding one plain item that nobody has touched. */
async function plainProject(t) {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const box = e2e.project();
  t.after(pinDerivedStateOff(box));
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'Thin status item');
  assert.equal(added.code, 0, added.err);
  return box;
}

/** Run `work` on the project's board, opened for writing the way the fixtures do, and close it. */
function onBoard(box, work) {
  const board = openKitBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try { return work(board); } finally { closeBoard(board); }
}

test('cli.io-status-thin.steps-aside: clause 1: thinStatusFacts returns null on a board with landing, relay, runner, health, job or verify-proof records, and on no board, drift, ReadNeedsWrite, writeRefused or schemaMissing [C7]', async (t) => {
  const box = await plainProject(t);
  const served = await thinStatusFacts({ cwd: box.repo });
  assert.ok(served, 'the door serves a plain board');
  assert.ok(Array.isArray(served.agents));
  const bare = join(box.dir, 'bare');
  mkdirSync(bare);
  box.git(bare, 'init', '-q', '-b', 'main');
  assert.equal(await thinStatusFacts({ cwd: bare }), null, 'no readable board');
  const event = kind => board => board.db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)').run(NOW, 'fixture', kind, null, '{}');
  for (const kind of ['landing_batch', 'relay-linked', 'runner-registered', 'health-scan', 'proof-run']) {
    const probe = await plainProject(t);
    assert.ok(await thinStatusFacts({ cwd: probe.repo }), `${kind}: served before the record`);
    onBoard(probe, event(kind));
    assert.equal(await thinStatusFacts({ cwd: probe.repo }), null, `${kind}: the door steps aside`);
  }
  const rows = {
    job: "INSERT INTO job (job_id, job_kind, job_step, job_created, job_updated) VALUES ('fixture-job', 'gate', 'queued', 1, 1)",
    run: "INSERT INTO run (run_job, run_kind, run_state, run_created, run_updated) VALUES ('fixture-run', 'test', 'queued', 1, 1)",
  };
  for (const [table, sql] of Object.entries(rows)) {
    const probe = await plainProject(t);
    assert.ok(await thinStatusFacts({ cwd: probe.repo }), `${table}: served before the row`);
    onBoard(probe, board => board.db.exec(sql));
    assert.equal(await thinStatusFacts({ cwd: probe.repo }), null, `${table}: the door steps aside`);
  }
  const failing = failure => (file, clock) => {
    const real = openBoardForRead(file, clock);
    const db = new Proxy(real.db, { get: (target, key) => key === 'prepare' ? () => { throw failure; } : typeof target[key] === 'function' ? target[key].bind(target) : target[key] });
    return new Proxy(real, { get: (target, key) => key === 'db' ? db : target[key] });
  };
  assert.equal(await thinStatusFacts({ cwd: box.repo, open: failing(new ReadNeedsWrite('fixture write')) }), null, 'ReadNeedsWrite');
  assert.equal(await thinStatusFacts({ cwd: box.repo, open: failing(new Error('no such table: fixture_missing')) }), null, 'schemaMissing');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try { db.exec('CREATE TABLE fixture_drift (x INTEGER)'); } finally { db.close(); }
  assert.equal(await thinStatusFacts({ cwd: box.repo }), null, 'drift');
});

test('cli.io-status-thin.write-refused: clause 1: thinStatusFacts returns null when the board refuses the read as a write refusal [C7]', async (t) => {
  const box = await plainProject(t);
  const refusing = (file, clock) => {
    const real = openBoardForRead(file, clock);
    const db = new Proxy(real.db, { get: (target, key) => key === 'prepare' ? () => { throw Object.assign(new Error('attempt to write a readonly database'), { code: 'ERR_SQLITE_ERROR', errcode: 8 }); } : typeof target[key] === 'function' ? target[key].bind(target) : target[key] });
    return new Proxy(real, { get: (target, key) => key === 'db' ? db : target[key] });
  };
  assert.equal(await thinStatusFacts({ cwd: box.repo, open: refusing }), null);
});

test('cli.io-status-thin.wired-behind-setting: clause 2: status.js calls the door first only when readThinCommands() is true, loads no thin module when it is off, and prints the same lines either way [C7]', async (t) => {
  const source = readFileSync(STATUS, 'utf8');
  assert.equal(/^import .*status\/thin\.js/mu.test(source), false, 'no static import of the thin module');
  const guarded = source.indexOf("if (readThinCommands()) await (await import('../status/thin.js')).thinStatusFacts(");
  assert.ok(guarded > 0, 'the door is imported and called only inside the readThinCommands() guard');
  assert.equal(source.split("import('../status/thin.js')").length - 1, 1, 'one lazy import');
  assert.ok(guarded < source.indexOf('await withBoardRead(ctx'), 'the door is asked before the full path reads the board');
  const box = await plainProject(t);
  const lines = result => result.out.split('\n').map(line => line.replace(/\d+ s ago/u, 'N s ago'));
  setReadThin(box, false);
  const off = await box.runLocal(box.repo, 'status');
  setReadThin(box, true);
  const on = await box.runLocal(box.repo, 'status');
  assert.equal(off.code, 0, off.err);
  assert.equal(on.code, 0, on.err);
  const thin = lines(on).filter(line => Boolean(line) && line !== 'next: pullboard next');
  const full = lines(off).filter(Boolean);
  assert.equal(on.code, off.code, 'thin and full status return the same exit code');
  assert.ok(thin.some(line => line.startsWith('board:')), 'thin status keeps item counts');
  assert.ok(thin.some(line => line.startsWith('lanes:')), 'thin status keeps lane names');
  assert.ok(thin.some(line => line.startsWith('capacity:')), 'thin status keeps capacity');
  assert.ok(thin.some(line => line.startsWith('Max useful builders:')), 'thin status keeps useful builders');
  assert.ok(thin.every(line => line.startsWith('board:') || line.startsWith('verdicts:') || line.startsWith('lanes:')
    || line.startsWith('ready buffer:') || line.startsWith('capacity:')
    || line.startsWith('Max useful agents now:') || line.endsWith('items can be built at once now.')
    || line.startsWith('Finish in about ') || line === 'Finish time: unknown.'
    || line.startsWith('Binding: ') || line.startsWith('Lever: ')
    || line.startsWith('Approval evidence count:') || line.startsWith('Unknown: ')
    || line.startsWith('Max useful builders:')), `thin status prints only counts, lanes, capacity and useful builders: ${thin.join(' | ')}`);
  for (const line of thin.filter(line => !line.startsWith('lanes:') && !line.startsWith('Max useful builders:'))) assert.ok(full.includes(line), `thin status shares the full-path field: ${line}`);
  assert.ok(full.some(line => line.startsWith('seats:')), 'full status keeps detailed sections');
  assert.ok(thin.length < full.length, 'thin status omits full-path details');
});
