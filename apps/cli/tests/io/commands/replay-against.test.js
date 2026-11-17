/** @pullboard-test-input source-cell apps/cli */
/** pullboard replay <table> --against <tag> prints the judge's class counts and differing events, holds them in --json, and is refused with the setting off [C7,R4,U150]. */
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
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../../packages/gate/tests/fixtures/child.js';
import { fixtureCommitAll } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { fixtureProjectPolicy } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { fixtureMachineSettings } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { run } from '../../../src/io/commands/replay.js';

const files = privateFixtureFiles('pullboard-replay-against-');
after(() => rmSync(files.root, { recursive: true, force: true }));
const MOVES = pathToFileURL(fileURLToPath(new URL('../../../../../packages/moves/index.js', import.meta.url))).href;
const TABLE = 'packages/demo/src/logic/demo.table.js';
const DAY = 24 * 60 * 60 * 1000;

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
/** A real repository with pullboard.json, tag v1 holding the table that keeps recorded detail, and a working tree whose table drops it, plus a board of recent moves. */
function repo() {
  const root = join(files.root, `repo-${++repos}`);
  mkdirSync(join(root, 'packages/demo/src/logic'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{ "type": "module" }\n');
  fixtureProjectPolicy(root);
  writeFileSync(join(root, TABLE), tableSource(true));
  fixtureCommitAll(root);
  runFixtureGit(['tag', 'v1'], { cwd: root });
  writeFileSync(join(root, TABLE), tableSource(false));
  mkdirSync(join(root, '.git', 'pullboard'), { recursive: true });
  const db = new DatabaseSync(join(root, '.git', 'pullboard', 'board.sqlite'));
  db.exec(`CREATE TABLE event (event_id INTEGER PRIMARY KEY AUTOINCREMENT, event_at TEXT NOT NULL, event_by TEXT NOT NULL, event_kind TEXT NOT NULL, item_id INTEGER, event_detail TEXT NOT NULL DEFAULT '{}')`);
  const add = db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)');
  const at = (days, hours = 0) => new Date(Date.now() - days * DAY + hours * 3600000).toISOString();
  add.run(at(6), 'coordinator', 'add', 1, '{}');
  add.run(at(5), 'coordinator', 'add', 2, '{}');
  add.run(at(2), 'core-1', 'claim', 1, '{"leaseUntil":"x"}');
  add.run(at(2, 1), 'core-1', 'submit', 1, '{}');
  db.close();
  return root;
}

/** Run `pullboard replay demo` in a fresh repository with moves.judgeByRelease set as given; returns the lines said, the JSON result and the code. */
async function replay(on, values) {
  const home = join(files.root, `machine-${++repos}`);
  mkdirSync(home, { recursive: true });
  fixtureMachineSettings(home, { moves: { judgeByRelease: on } });
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  const said = [];
  const results = [];
  try {
    const code = await run({ cwd: repo(), say: line => said.push(line), result: value => results.push(value) }, { first: 'demo', values });
    return { code, said, result: results[0] };
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

test('clause 1: replay demo --against v1 with the setting on prints one line per class count, then one line per differing event, exit 0 [C7,R4,U150]', async () => {
  const { code, said } = await replay(true, { against: 'v1' });
  assert.equal(code, 0);
  const at = said.findIndex(line => line === 'judge against v1:');
  assert.ok(at > 0, 'a judge heading follows the replay line');
  assert.deepEqual(said.slice(at + 1, at + 5), ['  same: 3', '  current-drifted: 1', '  released-wrong: 0', '  both-differ: 0']);
  assert.equal(said.length, at + 6);
  assert.match(said[at + 5], /^ {2}event 3: current-drifted \(board accepted claim, release accepted claim, table accepted claim\)$/u);
});

test('clause 2: the same command with --json holds judge.counts and judge.rows [C7,R4,U150]', async () => {
  const { result } = await replay(true, { against: 'v1', json: true });
  assert.deepEqual(result.judge.counts, { same: 3, currentDrifted: 1, releasedWrong: 0, bothDiffer: 0 });
  assert.deepEqual(result.judge.rows.map(row => [row.event, row.class]), [[3, 'current-drifted']]);
});

test('clause 3: with the setting off the same command is refused JUDGE_OFF and its next step names the setting [C7,U150]', async () => {
  await assert.rejects(replay(false, { against: 'v1' }), error => error.code === 'JUDGE_OFF' && String(error.next ?? error.message).includes('moves.judgeByRelease'));
});
