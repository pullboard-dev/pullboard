/** @pullboard-test-input apps/cli/pullboard.js apps/cli/src/io/hook/work.js apps/cli/src/io/submit/handoff/worker.js */
/** @pullboard-test-loads apps/cli/src/io/entry.js packages/store/src/io/board.js packages/store/src/io/board/indexes.js src/board-migrate.js apps/cli/src/io/context.js apps/cli/src/io/commands/status.js apps/cli/src/io/commands/show.js apps/cli/src/io/commands/list.js apps/cli/src/io/commands/version.js */
/** A read command opens the board read-only, so a writer holding the lock never stalls it [C7]. */
import { copyPackageFiles } from '../../../../../packages/runners/index.js';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  after,
  test,
} from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  cpSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import * as store from '../../../../../packages/store/index.js';
import {
  openBoard,
  openBoardForRead,
} from '../../../../lib/index.js';
import * as nativeBoard from '../../../../lib/index.js';
import { withBoard } from '../../../index.js';
import { withBoardRead } from '../../../index.js';
import { pathToFileURL } from 'node:url';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import {
  runFixtureChild,
  startFixtureChild as spawn,
} from '../../../tests/fixtures/child.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Hold the board's write lock from another process for `ms`; resolves once it is held, with the holder's exit. */
async function holdWriteLock(file, ms) {
  const script = [
    "const { DatabaseSync } = require('node:sqlite');",
    'const [file, ms] = process.argv.slice(1);',
    'const db = new DatabaseSync(file);',
    "db.exec('BEGIN IMMEDIATE');",
    "db.exec(\"INSERT INTO shout (shout_from, shout_to, shout_text, shout_at) VALUES ('holder', 'all', 'held', '2026-10-22T00:00:00Z')\");",
    "process.stdout.write('held\\n');",
    'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(ms));',
    "db.exec('COMMIT');",
  ].join('\n');
  const child = spawn(process.execPath, ['-e', script, file, String(ms)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((done) => child.once('close', (code) => done({ code, stderr })));
  await new Promise((held, fail) => {
    child.stdout.setEncoding('utf8').on('data', (chunk) => { if (chunk.includes('held')) held(); });
    child.once('close', (code) => fail(new Error(`the lock holder exited ${code} before holding: ${stderr}`)));
  });
  return { closed };
}

const HOMES = ['PULLBOARD_HOME', 'PULLBOARD_MACHINE_HOME'];

/**
 * Copy this source outside any checkout, as a release is installed. Why: only trunk code opens a
 * shared board for writing (#1031), so code run from a branch worktree would never meet the lock.
 */
function released(box) {
  const release = join(box.dir, 'release');
  copyPackageFiles(resolve(import.meta.dirname, '../../../../..'), release);
  return release;
}

/**
 * Run one command of the released code in this process under the fixture's homes, with the time it
 * took. Why in process: a fresh node's startup varies by hundreds of ms on a loaded machine.
 */
async function timed(box, cwd, ...argv) {
  const { cli$main: main } = await import(pathToFileURL(join(box.release, 'apps', 'cli', 'index.js')).href);
  const saved = HOMES.map((name) => process.env[name]);
  for (const name of HOMES) process.env[name] = box.env[name];
  let out = '';
  let err = '';
  const startedAt = performance.now();
  try {
    const code = await main(argv, { cwd, loadNativeBoard: () => import(pathToFileURL(join(box.release, 'apps', 'cli', 'index.js')).href),
      hookWorker: join(box.release, 'apps/cli/src/io/hook/work.js'), submitHandoffWorker: join(box.release, 'apps/cli/src/io/submit/handoff/worker.js'),
      /** Launch only the released sender actually requested by this command. */
      launchRelaySender: (root, env) => { void import(pathToFileURL(join(box.release, 'apps', 'lib', 'index.js')).href).then(sender => sender.launchRelaySender(root, env)).catch(() => {}); }, stdout: { isTTY: false, write: (text) => { out += text; } }, stderr: { write: (text) => { err += text; } } });
    return { code, out, err, ms: performance.now() - startedAt };
  } finally {
    HOMES.forEach((name, index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]; });
  }
}

/** The median of an odd list of numbers. */
const median = (values) => [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)];

const ITEMS = 1_000;
const EVENTS = 45_000;
const SHOUTS = 23_000;

/**
 * Seed the board to our size (22 Oct: about 1,000 items, 45,000 events, 23,000 shouts) in one
 * transaction of plain inserts, so the timing below reads a board as big as the real one.
 */
function seed(file) {
  const db = new DatabaseSync(file);
  try {
    db.exec('BEGIN IMMEDIATE');
    const at = '2026-10-22T00:00:00.000Z';
    db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      INSERT INTO item (item_lane, item_title, item_criterion, item_created_by, item_created_at, item_updated_at)
      SELECT 'web', 'Seeded item ' || i, 'renders', 'coordinator', ?, ? FROM n`).run(ITEMS, at, at);
    db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) SELECT ?, 'coordinator', 'note', 1 + i % ?, '{}' FROM n`).run(EVENTS, at, ITEMS);
    db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
      INSERT INTO shout (shout_from, shout_to, shout_text, shout_at) SELECT 'coordinator', 'web', 'seeded shout ' || i, ? FROM n`).run(SHOUTS, at);
    db.exec('COMMIT');
  } finally { db.close(); }
}

/** #1044's hot-path indexes (packages/store/src/io/board/indexes.js), which reach an existing board with schema version 3. */
const HOT_INDEXES = ['shout_answers', 'shout_open_decision', 'shout_open_request', 'shout_evidence_item', 'shout_from_at', 'event_by_at', 'event_kind_id'];

const READS = [['version'], ['show', '1'], ['status'], ['list']];
const RUNS = 5;

test('read-only CLI fallback preserves coordinator registration and moved events [C7,B3]', () => {
  const box = e2e.sandbox();
  box.repo = join(box.dir, 'repo');
  mkdirSync(box.repo);
  box.git(box.repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(e2e.CONFIG));
  writeFileSync(join(box.repo, 'SPEC.md'), e2e.SPEC);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-qm', 'Create the read fallback fixture');
  box.release = released(box);
  const cli = () => runFixtureChild(process.execPath, [join(box.release, 'apps/cli/pullboard.js'), 'status', '--json'],
    { cwd: box.repo, env: box.env, encoding: 'utf8' });
  const first = cli();
  assert.equal(first.status, 0, first.failure ?? first.stderr);
  assert.equal(JSON.parse(first.stdout).me.id, 'coordinator');
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const board = openBoard(file);
  try {
    assert.equal(store.events(board).filter(event => event.event_kind === 'join').length, 1);
    store.board_ensureCoordinator(board, '/previous/coordinator-location');
  } finally { store.closeBoard(board); }
  const moved = cli();
  assert.equal(moved.status, 0, moved.failure ?? moved.stderr);
  const read = openBoardForRead(file);
  let events;
  try {
    assert.equal(store.agentById(read, 'coordinator').agent_path, box.repo);
    events = store.events(read);
    const moves = events.filter(event => event.event_kind === 'moved');
    assert.equal(moves.length, 2, 'the public move away and CLI move back each retain their event');
    assert.equal(JSON.parse(moves.at(-1).event_detail).path, box.repo);
  } finally { store.closeBoard(read); }
  assert.equal(cli().status, 0);
  const ctx = { file, info: { root: box.repo, isMain: true }, config: e2e.CONFIG,
    clock: store.systemClock, allowSchemaUpgrade: true, nativeBoard, io: { err() {} } };
  assert.equal(withBoardRead(ctx, opened => store.events(opened).length), events.length,
    'the existing public read API remains synchronous and an ordinary read appends no event');
  assert.equal(withBoard(ctx, opened => store.agentById(opened, 'coordinator').agent_path), box.repo,
    'the existing public board API remains synchronous');
});

/** Each read's median over RUNS in-process runs, failing on any refusal. */
async function medians(box, argv) {
  const times = [];
  for (let run = 0; run < RUNS; run += 1) {
    const result = await timed(box, box.repo, ...argv);
    assert.equal(result.code, 0, `${argv.join(' ')}: ${result.err}`);
    times.push(result.ms);
  }
  return median(times);
}

test('a read answers while a writer holds the lock [C7]', async (t) => {
  const box = e2e.project();
  box.release = released(box);
  assert.equal(fixtureAdd(box.run, box.repo, 'web', 'Page', '--specs', 'G1', '--criterion', 'renders').code, 0);
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  seed(file);
  for (const argv of READS) {
    const free = await medians(box, argv);
    // Each read gets its own 3 s hold, so all five locked runs fall inside it.
    const holder = await holdWriteLock(file, 3000);
    const startedAt = performance.now();
    const held = await medians(box, argv);
    const heldFor = performance.now() - startedAt;
    assert.equal((await holder.closed).code, 0, 'the holder kept the lock and committed');
    assert.ok(heldFor < 3000, `every ${argv[0]} run finished inside the 3 s hold (${Math.round(heldFor)} ms)`); // budget: ceiling is the 3 s hold declared above; a read that waits out the lock ends after it
    t.diagnostic(`${argv[0]}: median ${Math.round(held)} ms with a writer holding the lock, ${Math.round(free)} ms without, over ${RUNS} runs`);
    assert.ok(held - free < 100, `${argv[0]}: a held writer added ${Math.round(held - free)} ms to the median`); // budget: approved row criterion bar, under 100 ms over the unlocked median (shout #23649)
  }

  // A version-2 board, from before #1044's hot-path indexes, is still migrated by the next command
  // that writes, from the released copy: it gains them then, and never on a read.
  const db = new DatabaseSync(file);
  db.exec(`${HOT_INDEXES.map((name) => `DROP INDEX ${name};`).join(' ')} PRAGMA user_version = 2`);
  db.close();
  const cli = (...argv) => runFixtureChild(process.execPath, [join(box.release, 'apps/cli/pullboard.js'), ...argv], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  /** The hot-path indexes the board has, read without touching it. */
  const hotIndexes = () => {
    const board = store.openBoardReadOnly(file);
    try {
      return board.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (${HOT_INDEXES.map(() => '?').join(', ')}) ORDER BY name`)
        .all(...HOT_INDEXES).map((row) => row.name);
    } finally { board.close(); }
  };
  /** The board's PRAGMA user_version, read without touching it. */
  const version = () => {
    const board = store.openBoardReadOnly(file);
    try { return board.prepare('PRAGMA user_version').get().user_version; } finally { board.close(); }
  };
  // A read on the older board answers as it is and leaves it older, even from code that may migrate.
  const read = cli('status');
  assert.equal(read.status, 0, read.failure ?? read.stderr);
  assert.match(read.stdout, /board: 1001 open/u);
  assert.equal(version(), 2, 'status never migrates the board');
  assert.deepEqual(hotIndexes(), [], 'status adds no index');
  const write = cli('add', 'web', 'Footer', '--specs', 'G1', '--criterion', 'renders');
  assert.equal(write.status, 0, write.failure ?? write.stderr);
  assert.equal(version(), store.SCHEMA_VERSION, 'the next write command migrates it');
  assert.equal(store.SCHEMA_VERSION, 3, 'the version that carries the hot-path indexes');
  assert.deepEqual(hotIndexes(), [...HOT_INDEXES].sort(), 'the write gave the version-2 board every hot-path index');

  // At the current version, a shape changed outside pullboard is reported once and left as it is.
  const drifted = new DatabaseSync(file);
  drifted.exec('DROP INDEX event_item_id_event_id; PRAGMA application_id = 7');
  drifted.close();
  const reported = cli('add', 'web', 'Header', '--specs', 'G1', '--criterion', 'renders');
  assert.equal(reported.status, 0, reported.failure ?? reported.stderr);
  assert.equal(reported.stderr.match(/different shape/gu)?.length, 1, reported.stderr);
  const left = store.openBoardReadOnly(file);
  try {
    assert.equal(left.prepare('PRAGMA application_id').get().application_id, 7, 'no migration restamped the drifted board');
    assert.equal(left.prepare("SELECT 1 FROM sqlite_master WHERE name = 'event_item_id_event_id'").get(), undefined, 'no migration rebuilt its index');
  } finally { left.close(); }
});
