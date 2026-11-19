/** @pullboard-test-input source-cell packages/moves */
/** Replay and explain reports load a table by name, count how often it agrees with the board, and refuse an unknown table naming the known ones [C7,#8071,#8072]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { after } from 'node:test';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';
import { fixtureCommitAll } from '../../../../gate/tests/fixtures/testkit.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';
import { explainReport } from '../../../index.js';
import { judgeAllReport } from '../../../index.js';
import { replayReport } from '../../../index.js';

const files = privateFixtureFiles('pullboard-move-report-');
after(() => rmSync(files.root, { recursive: true, force: true }));
const MOVES = pathToFileURL(fileURLToPath(new URL('../../../index.js', import.meta.url))).href;
const REPO = fileURLToPath(new URL('../../../../../', import.meta.url));
const NOW = Date.parse('2026-11-12T00:00:00.000Z');
const CUT = '2026-11-05T00:00:00.000Z';

/** A repository tree holding one table called demo, which accepts every move and writes the event the board would, with empty detail. */
function tree() {
  const root = join(files.root, 'tree');
  mkdirSync(join(root, 'packages/demo/src/logic'), { recursive: true });
  writeFileSync(join(root, 'packages/demo/src/logic/demo.table.js'), `
    import { defineRules } from ${JSON.stringify(MOVES)};
    export const DEMO_RULES = defineRules({ known: { says: 'the move is one the board knows', holds: (s, m) => m.kind !== 'zzz' } });
    export const DEMO_TABLE = { name: 'demo',
      guards: [{ id: 'known', requires: 'known', code: 'UNKNOWN_MOVE', message: 'no such move', next: 'use a move the board knows' }],
      outcomes: [{ id: 'plain', patch: () => ({}), events: (s, m) => [{ kind: m.kind, by: m.actor, detail: {} }] }] };`);
  writeFileSync(join(root, 'packages/demo/src/logic/odd.table.js'), 'export const ODD = 1;');
  return root;
}

/** A board on real SQLite: two adds before the cut, a claim whose recorded detail the demo table would not write, and a submit it would. */
let boards = 0;
function board() {
  const file = join(files.root, `board-${++boards}.sqlite`);
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE event (event_id INTEGER PRIMARY KEY AUTOINCREMENT, event_at TEXT NOT NULL, event_by TEXT NOT NULL, event_kind TEXT NOT NULL, item_id INTEGER, event_detail TEXT NOT NULL DEFAULT '{}')`);
  const add = db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)');
  add.run('2026-11-01T00:00:00.000Z', 'coordinator', 'add', 1, '{}');
  add.run('2026-11-02T00:00:00.000Z', 'coordinator', 'add', 2, '{}');
  add.run('2026-11-10T00:00:00.000Z', 'core-1', 'claim', 1, '{"leaseUntil":"x"}');
  add.run('2026-11-10T01:00:00.000Z', 'core-1', 'submit', 1, '{}');
  db.close();
  return file;
}

test('moves.report.replay-counts-agreed-disagreed-and-before-cut: clause 1: replay counts agreed, disagreed and before-cut records and names each disagreement by event id [C7,#8071]', async () => {
  const report = await replayReport({ root: tree(), boardFile: board(), name: 'demo', days: 20, now: NOW, cut: CUT });
  assert.deepEqual([report.agreed, report.disagreed, report.beforeCut, report.notReplayable], [1, 1, 2, 0]);
  assert.deepEqual(report.disagreements.map(miss => [miss.event, miss.differs]), [[3, 'detail']]);
  assert.equal(report.table, 'demo');
});

test('moves.report.the-report-is-one-plain-document-with: clause 2: the report is one plain document with the same counts, ready for --json [C7,#8071]', async () => {
  const report = await replayReport({ root: tree(), boardFile: board(), name: 'demo', days: 20, now: NOW, cut: CUT });
  const round = JSON.parse(JSON.stringify(report));
  assert.deepEqual(round, report);
  assert.equal(round.days, 20);
  assert.equal(round.since, '2026-10-23T00:00:00.000Z');
});

test('moves.report.an-unknown-table-is-refused-replay-table: clause 3: an unknown table is refused REPLAY_TABLE or EXPLAIN_TABLE naming the known tables [C7,#8071,#8072]', async () => {
  const root = tree();
  await assert.rejects(replayReport({ root, boardFile: board(), name: 'nope', now: NOW, cut: CUT }),
    error => error.code === 'REPLAY_TABLE' && error.message.includes('demo') && error.message.includes('odd'));
  await assert.rejects(explainReport({ root, name: 'nope' }), error => error.code === 'EXPLAIN_TABLE' && error.message.includes('demo'));
  await assert.rejects(explainReport({ root, name: undefined }), error => error.code === 'EXPLAIN_TABLE');
  await assert.rejects(replayReport({ root, boardFile: board(), name: 'odd', now: NOW, cut: CUT }), error => error.code === 'REPLAY_TABLE' && error.message.includes('*_TABLE'));
  await assert.rejects(replayReport({ root, boardFile: board(), name: 'demo', days: 0, now: NOW, cut: CUT }), error => error.code === 'REPLAY_DAYS');
});

test('moves.report.explain-lists-the-guards-in-order-with: clause 1: explain lists the guards in order with code and next step, from explainTable [C7,#8072]', async () => {
  const demo = await explainReport({ root: tree(), name: 'demo' });
  assert.deepEqual(demo.guards, [{ order: 1, id: 'known', code: 'UNKNOWN_MOVE', fact: 'known', says: 'the move is one the board knows', next: 'use a move the board knows' }]);
  assert.equal((await explainReport({ root: REPO, name: 'backbone' })).table, 'backbone');
});

test('moves.report.replay-never-writes-the-board-it-reads: clause 1: replay never writes the board it reads [C7,#8071]', async () => {
  const file = board();
  const db = new DatabaseSync(file, { readOnly: true });
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM event').get().n;
  const before = count();
  await replayReport({ root: tree(), boardFile: file, name: 'demo', days: 20, now: NOW, cut: CUT });
  assert.equal(count(), before);
  db.close();
});

/** judgeAllReport judges every current table against one release: drifted tables named, new tables listed, off by default, read-only [C7,R4,U150]. */
{
  const files = privateFixtureFiles('pullboard-judge-all-');
  after(() => rmSync(files.root, { recursive: true, force: true }));
  const MOVES = pathToFileURL(fileURLToPath(new URL('../../../index.js', import.meta.url))).href;
  const NOW = Date.parse('2026-11-12T00:00:00.000Z');
  const CUT = '2026-11-05T00:00:00.000Z';
  const dir = (name) => `packages/${name}/src/logic`;
  
  /** A table named `name` that accepts every move and writes the event the board would, keeping the recorded detail or dropping it. */
  function tableSource(name, keepDetail) {
    const up = name.toUpperCase();
    return `
      import { defineRules } from ${JSON.stringify(MOVES)};
      export const ${up}_RULES = defineRules({ known: { says: 'the move is one the board knows', holds: (s, m) => m.kind !== 'zzz' } });
      export const ${up}_TABLE = { name: '${name}',
        guards: [{ id: 'known', requires: 'known', code: 'UNKNOWN_MOVE', message: 'no such move', next: 'use a move the board knows' }],
        outcomes: [{ id: 'plain', patch: () => ({}), events: (s, m) => [{ kind: m.kind, by: m.actor, detail: ${keepDetail ? 'm.detail' : '{}'} }] }] };`;
  }
  
  /** Write a table into the working tree. */
  function put(root, name, keepDetail) {
    mkdirSync(join(root, dir(name)), { recursive: true });
    writeFileSync(join(root, dir(name), `${name}.table.js`), tableSource(name, keepDetail));
  }
  
  let counter = 0;
  /** A repository tagged v1.0.0 holding table demo; the working tree then drops demo's detail (when `drift`) and adds table extra. */
  function repo(drift) {
    const root = join(files.root, `repo-${++counter}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'package.json'), '{ "type": "module" }\n');
    put(root, 'demo', true);
    fixtureCommitAll(root);
    runFixtureGit(['tag', 'v1.0.0'], { cwd: root });
    put(root, 'demo', !drift);
    if (drift) put(root, 'extra', true);
    return root;
  }
  
  /** A board on real SQLite with one claim carrying detail. */
  function board() {
    const file = join(files.root, `board-${++counter}.sqlite`);
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE event (event_id INTEGER PRIMARY KEY AUTOINCREMENT, event_at TEXT NOT NULL, event_by TEXT NOT NULL, event_kind TEXT NOT NULL, item_id INTEGER, event_detail TEXT NOT NULL DEFAULT '{}')`);
    db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)').run('2026-11-10T00:00:00.000Z', 'core-1', 'claim', 1, '{"leaseUntil":"x"}');
    db.close();
    return file;
  }
  
  /** Run `work` with moves.judgeByRelease set as given in a private machine home. */
  async function withSetting(on, work) {
    const home = join(files.root, `machine-${++counter}`);
    mkdirSync(home, { recursive: true });
    fixtureMachineSettings(home, { moves: { judgeByRelease: on } });
    const saved = process.env.PULLBOARD_MACHINE_HOME;
    process.env.PULLBOARD_MACHINE_HOME = home;
    try { return await work(); } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
  }
  
  test('moves.judge-all.names-drifted-and-new: clause 1: judgeAllReport names the table whose answers drifted since the tag, lists the table the tag lacked as new, and is not clean [C7,R4]', async () => {
    const out = await withSetting(true, () => judgeAllReport({ root: repo(true), boardFile: board(), against: 'v1.0.0', days: 20, now: NOW, cut: CUT }));
    assert.deepEqual(out.drifted, ['demo']);
    assert.deepEqual(out.newTables, ['extra']);
    assert.equal(out.clean, false);
    assert.deepEqual(out.rows.map(row => row.table), ['demo']);
  });
  
  test('moves.judge-all.clean-and-last-resolved: clause 2: judgeAllReport is clean when the tree equals the tag, and against last is reported as the resolved tag v1.0.0 [C7,R4]', async () => {
    const out = await withSetting(true, () => judgeAllReport({ root: repo(false), boardFile: board(), against: 'last', days: 20, now: NOW, cut: CUT }));
    assert.deepEqual(out.drifted, []);
    assert.equal(out.clean, true);
    assert.equal(out.against, 'v1.0.0');
  });
  
  test('moves.judge-all.off-is-refused-and-read-only: clause 3: judgeAllReport with the setting off is refused JUDGE_OFF naming the setting, and a judged run leaves the board file byte for byte unchanged [C7,R4]', async () => {
    const file = board();
    const before = readFileSync(file);
    await withSetting(false, () => assert.rejects(judgeAllReport({ root: repo(true), boardFile: file, against: 'v1.0.0', days: 20, now: NOW, cut: CUT }),
      error => error.code === 'JUDGE_OFF' && String(error.next ?? error.message).includes('moves.judgeByRelease')));
    await withSetting(true, () => judgeAllReport({ root: repo(true), boardFile: file, against: 'v1.0.0', days: 20, now: NOW, cut: CUT }));
    assert.deepEqual(readFileSync(file), before);
  });
}
