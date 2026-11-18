/** replayReport with an against tag judges the released table and the current table over the same recorded moves, and is refused with the setting off [C7,R4,U150]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
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
import { replayReport } from '../../../index.js';

const files = privateFixtureFiles('pullboard-judge-report-');
after(() => rmSync(files.root, { recursive: true, force: true }));
const MOVES = pathToFileURL(fileURLToPath(new URL('../../../index.js', import.meta.url))).href;
const NOW = Date.parse('2026-11-12T00:00:00.000Z');
const CUT = '2026-11-05T00:00:00.000Z';
const TABLE = 'packages/demo/src/logic/demo.table.js';

/** A demo table that accepts every move and writes the event the board would, with the recorded detail kept or, for the current table, dropped. */
function tableSource(keepDetail) {
  return `
    import { defineRules } from ${JSON.stringify(MOVES)};
    export const DEMO_RULES = defineRules({ known: { says: 'the move is one the board knows', holds: (s, m) => m.kind !== 'zzz' } });
    export const DEMO_TABLE = { name: 'demo',
      guards: [{ id: 'known', requires: 'known', code: 'UNKNOWN_MOVE', message: 'no such move', next: 'use a move the board knows' }],
      outcomes: [{ id: 'plain', patch: () => ({}), events: (s, m) => [{ kind: m.kind, by: m.actor, detail: ${keepDetail ? 'm.detail' : '{}'} }] }] };`;
}

let repos = 0;
/** A real repository whose tag v1 holds the table that keeps the recorded detail, and whose working tree then holds one that drops it. */
function repo() {
  const root = join(files.root, `repo-${++repos}`);
  mkdirSync(join(root, 'packages/demo/src/logic'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{ "type": "module" }\n');
  writeFileSync(join(root, TABLE), tableSource(true));
  fixtureCommitAll(root);
  runFixtureGit(['tag', 'v1'], { cwd: root });
  writeFileSync(join(root, TABLE), tableSource(false));
  return root;
}

/** A board on real SQLite: two adds before the cut, a claim whose detail only the released table keeps, and a submit both agree on. */
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

/** Run `work` with moves.judgeByRelease set as given in a private machine home, restoring the home afterwards. */
async function withSetting(on, work) {
  const home = join(files.root, `machine-${++boards}`);
  mkdirSync(home, { recursive: true });
  fixtureMachineSettings(home, { moves: { judgeByRelease: on } });
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  try { return await work(); } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

test('moves.judge-report.against-returns-judge-counts-and-rows: clause 1: replayReport with against set returns judge.counts and one judge.rows entry per differing recorded move [C7,R4,U150]', async () => {
  const report = await withSetting(true, () => replayReport({ root: repo(), boardFile: board(), name: 'demo', days: 20, now: NOW, cut: CUT, against: 'v1' }));
  assert.equal(report.judge.against, 'v1');
  assert.deepEqual(report.judge.counts, { same: 1, currentDrifted: 1, releasedWrong: 0, bothDiffer: 0 });
  assert.deepEqual(report.judge.rows.map(row => [row.event, row.class]), [[3, 'current-drifted']]);
});

test('moves.judge-report.without-against-the-report-is-unchanged: clause 2: replayReport without against returns exactly the fields it returned before, with no judge key [C7,U150]', async () => {
  const plain = await withSetting(false, () => replayReport({ root: repo(), boardFile: board(), name: 'demo', days: 20, now: NOW, cut: CUT }));
  const on = await withSetting(true, () => replayReport({ root: repo(), boardFile: board(), name: 'demo', days: 20, now: NOW, cut: CUT }));
  assert.deepEqual(Object.keys(plain).sort(), ['agreed', 'beforeCut', 'cut', 'days', 'disagreed', 'disagreements', 'notReplayable', 'since', 'table', 'total', 'unreplayable']);
  assert.deepEqual(on, plain, 'the setting alone changes nothing');
});

test('moves.judge-report.against-with-the-setting-off-is-refused: clause 3: replayReport with against and moves.judgeByRelease off is refused JUDGE_OFF, whose next step names the setting [C7,U150]', async () => {
  await withSetting(false, () => assert.rejects(replayReport({ root: repo(), boardFile: board(), name: 'demo', days: 20, now: NOW, cut: CUT, against: 'v1' }),
    error => error.code === 'JUDGE_OFF' && String(error.next ?? error.message).includes('moves.judgeByRelease')));
});
