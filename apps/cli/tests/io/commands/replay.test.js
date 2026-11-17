/** @pullboard-test-input source-cell apps/cli */
/** pullboard replay --all --against <tag|last> judges every table, prints one line each and a verdict, holds the summary in --json, and is refused when misused or with the setting off [C7,R4,U150]. */
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
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../../packages/gate/tests/fixtures/child.js';
import { fixtureCommitAll } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { fixtureProjectPolicy } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { fixtureMachineSettings } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { run } from '../../../src/io/commands/replay.js';

const files = privateFixtureFiles('pullboard-replay-all-');
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
function repo(drift = true) {
  const root = join(files.root, `repo-${++repos}`);
  mkdirSync(join(root, 'packages/demo/src/logic'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{ "type": "module" }\n');
  fixtureProjectPolicy(root);
  writeFileSync(join(root, TABLE), tableSource(true));
  fixtureCommitAll(root);
  runFixtureGit(['tag', 'v1.0.0'], { cwd: root });
  writeFileSync(join(root, TABLE), tableSource(!drift));
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

/** Run `pullboard replay` in a fresh repository with moves.judgeByRelease set as given; returns the lines said, the JSON result and the code. */
async function replay(on, args, drift = true) {
  const home = join(files.root, `machine-${++repos}`);
  mkdirSync(home, { recursive: true });
  fixtureMachineSettings(home, { moves: { judgeByRelease: on } });
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  const said = [];
  const results = [];
  try {
    const root = repo(drift);
    const board = join(root, '.git', 'pullboard', 'board.sqlite');
    const before = readFileSync(board);
    const code = await run({ cwd: root, say: line => said.push(line), result: value => results.push(value) }, args);
    return { code, said, result: results[0], unchanged: readFileSync(board).equals(before) };
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

test('cli.io-commands-replay.cli-replay-all-prints-lines-and-verdict: cli.replay.all-prints-lines-and-verdict: clause 1: replay --all --against v1.0.0 prints a heading, one line per table with its four class counts and a final drifted verdict, exit 0 [C7,R4,U150]', async () => {
  const { code, said } = await replay(true, { values: { all: true, against: 'v1.0.0' } });
  assert.equal(code, 0);
  assert.deepEqual(said, ['judge against v1.0.0: 1 tables', '  demo: same 3, current-drifted 1, released-wrong 0, both-differ 0', 'verdict: drifted demo']);
});

test('cli.io-commands-replay.cli-replay-all-json-holds-summary-and: cli.replay.all-json-holds-summary-and-last: clause 2: the same command with --json holds rows, newTables, drifted and clean, and --against last reports against v1.0.0 [C7,R4,U150]', async () => {
  const { result } = await replay(true, { values: { all: true, against: 'last', json: true } });
  assert.equal(result.against, 'v1.0.0');
  assert.deepEqual(result.drifted, ['demo']);
  assert.deepEqual(result.newTables, []);
  assert.equal(result.clean, false);
  assert.deepEqual(result.rows.map(row => row.table), ['demo']);
});

test('cli.io-commands-replay.cli-replay-all-misuse-and-off-are: cli.replay.all-misuse-and-off-are-refused: clause 3: --all without --against, and --all with a table name, are refused USAGE, and with the setting off the --all form is refused JUDGE_OFF [C7,R4,U150]', async () => {
  await assert.rejects(replay(true, { values: { all: true } }), error => error.code === 'USAGE');
  await assert.rejects(replay(true, { first: 'demo', values: { all: true, against: 'v1.0.0' } }), error => error.code === 'USAGE');
  await assert.rejects(replay(false, { values: { all: true, against: 'v1.0.0' } }), error => error.code === 'JUDGE_OFF' && String(error.next ?? error.message).includes('moves.judgeByRelease'));
});

test('cli.io-commands-replay.cli-replay-fail-on-drift-exits-1: cli.replay.fail-on-drift-exits-1-naming-tables: clause 1: replay --all --against v1.0.0 --fail-on-drift exits 1 with output naming the drifted table demo [C7,R4,U150]', async () => {
  const { code, said } = await replay(true, { values: { all: true, against: 'v1.0.0', 'fail-on-drift': true } });
  assert.equal(code, 1);
  assert.ok(said.some(line => line === 'drift: demo decide moves differently than v1.0.0'));
});

test('cli.io-commands-replay.cli-replay-fail-on-drift-clean-exits: cli.replay.fail-on-drift-clean-exits-0-read-only: clause 2: --fail-on-drift exits 0 and prints verdict: clean when the tables match the tag, and the board file is byte for byte unchanged after either run [C7,R4,U150]', async () => {
  const clean = await replay(true, { values: { all: true, against: 'v1.0.0', 'fail-on-drift': true } }, false);
  assert.equal(clean.code, 0);
  assert.ok(clean.said.includes('verdict: clean'));
  assert.equal(clean.unchanged, true);
  const drifted = await replay(true, { values: { all: true, against: 'v1.0.0', 'fail-on-drift': true } });
  assert.equal(drifted.unchanged, true);
});

test('cli.io-commands-replay.cli-replay-fail-on-drift-needs-all: cli.replay.fail-on-drift-needs-all: clause 3: replay demo --against v1.0.0 --fail-on-drift without --all is refused USAGE [C7,R4,U150]', async () => {
  await assert.rejects(replay(true, { first: 'demo', values: { against: 'v1.0.0', 'fail-on-drift': true } }), error => error.code === 'USAGE');
});
