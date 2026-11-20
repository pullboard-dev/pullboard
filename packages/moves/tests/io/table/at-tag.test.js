/** @pullboard-test-input source-cell packages/moves */
/** A move table loads from a release tag into a private folder and answers as the released rules did, whatever the working tree says now [C7,R4,U150]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { after } from 'node:test';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';
import { fixtureCommitAll } from '../../../../gate/tests/fixtures/testkit.js';
import { loadMoveTable } from '../../../index.js';
import { loadMoveTableAtTag } from '../../../index.js';
import { runTable } from '../../../index.js';
import { DatabaseSync } from 'node:sqlite';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';
import { replayReport } from '../../../index.js';

const files = privateFixtureFiles('pullboard-at-tag-');
after(() => rmSync(files.root, { recursive: true, force: true }));
const MOVES = pathToFileURL(fileURLToPath(new URL('../../../index.js', import.meta.url))).href;
const TABLE = 'packages/demo/src/logic/demo.table.js';

/** A demo table whose only guard always refuses with the code its sibling module names (or, when none, the code given inline). */
function tableSource(code) {
  return `
    import { defineRules } from ${JSON.stringify(MOVES)};
    ${code.import ?? ''}
    export const DEMO_RULES = defineRules({ never: { says: 'the move is never allowed', holds: () => false } });
    export const DEMO_TABLE = { name: 'demo',
      guards: [{ id: 'never', requires: 'never', code: ${code.value}, message: 'refused', next: 'stop' }],
      outcomes: [{ id: 'plain', patch: () => ({}), events: () => [] }] };`;
}

let repos = 0;
/** A real repository whose tag v1 holds a table refusing A through a sibling module, and whose working tree then holds one refusing B. */
function repo() {
  const root = join(files.root, `repo-${++repos}`);
  mkdirSync(join(root, 'packages/demo/src/logic'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{ "type": "module" }\n');
  writeFileSync(join(root, 'packages/demo/src/logic/code.js'), "export const CODE = 'A';\n");
  writeFileSync(join(root, TABLE), tableSource({ import: "import { CODE } from './code.js';", value: 'CODE' }));
  fixtureCommitAll(root);
  runFixtureGit(['tag', 'v1'], { cwd: root });
  writeFileSync(join(root, 'packages/demo/src/logic/code.js'), "export const CODE = 'B';\n");
  writeFileSync(join(root, TABLE), tableSource({ value: "'B'" }));
  return root;
}

/** The code a table refuses a move with. */
const refusal = ({ table, rules }) => runTable(table, rules, {}, { name: 'go' }).refused.code;

test('moves.at-tag.tag-rules-answer-the-tag-code: clause 1: a table loaded from a tag answers the code the tag held, while the working tree table (refusing another code) is untouched [C7,R4,U150]', async () => {
  const root = repo();
  const before = readFileSync(join(root, TABLE), 'utf8');
  const released = await loadMoveTableAtTag(root, 'demo', 'v1');
  const current = await loadMoveTable(root, 'demo', 'REPLAY_TABLE');
  assert.equal(refusal(released), 'A');
  assert.equal(refusal(current), 'B');
  assert.equal(released.tag, 'v1');
  assert.equal(readFileSync(join(root, TABLE), 'utf8'), before, 'the working tree file is byte for byte as it was');
  assert.equal(runFixtureGit(['status', '--porcelain'], { cwd: root }).split('\n').filter(Boolean).length, 2, 'only the two edits the test made are dirty');
  released.dispose();
});

test('moves.at-tag.unknown-tag-is-refused-naming-tags: clause 2: an unknown tag is refused JUDGE_TAG naming the tags the repository has [C7,R4,U150]', async () => {
  const root = repo();
  await assert.rejects(loadMoveTableAtTag(root, 'demo', 'v9'), error => error.code === 'JUDGE_TAG' && error.message.includes('v1') && error.message.includes('v9'));
  await assert.rejects(loadMoveTableAtTag(root, 'demo', undefined), error => error.code === 'JUDGE_TAG');
  await assert.rejects(loadMoveTableAtTag(root, 'nope', 'v1'), error => error.code === 'JUDGE_TABLE' && error.message.includes('demo'));
});

test('moves.at-tag.private-folder-gone-after-dispose: clause 3: the private folder is gone after dispose is called [C7,R4,U150]', async () => {
  const root = repo();
  const scratch = join(files.root, 'scratch');
  mkdirSync(scratch);
  const saved = process.env.PULLBOARD_SCRATCH;
  process.env.PULLBOARD_SCRATCH = scratch;
  try {
    const loaded = await loadMoveTableAtTag(root, 'demo', 'v1');
    assert.equal(readdirSync(scratch).length, 1, 'one private folder holds the tag files');
    loaded.dispose();
    assert.deepEqual(readdirSync(scratch), []);
    loaded.dispose();
    await assert.rejects(loadMoveTableAtTag(root, 'nope', 'v1'), error => error.code === 'JUDGE_TABLE');
    assert.deepEqual(readdirSync(scratch), [], 'a refused load leaves no folder behind');
  } finally { if (saved === undefined) delete process.env.PULLBOARD_SCRATCH; else process.env.PULLBOARD_SCRATCH = saved; }
});

{
  const files = privateFixtureFiles('pullboard-at-tag-last-');
  after(() => rmSync(files.root, { recursive: true, force: true }));
  const MOVES = pathToFileURL(fileURLToPath(new URL('../../../index.js', import.meta.url))).href;
  const TABLE = 'packages/demo/src/logic/demo.table.js';
  const NOW = Date.parse('2026-11-12T00:00:00.000Z');
  const CUT = '2026-11-05T00:00:00.000Z';

  /** A demo table whose only guard always refuses with the given code. */
  function tableSource(code) {
    return `
      import { defineRules } from ${JSON.stringify(MOVES)};
      export const DEMO_RULES = defineRules({ never: { says: 'the move is never allowed', holds: () => false } });
      export const DEMO_TABLE = { name: 'demo',
        guards: [{ id: 'never', requires: 'never', code: '${code}', message: 'refused', next: 'stop' }],
        outcomes: [{ id: 'plain', patch: () => ({}), events: (s, m) => [{ kind: m.kind, by: m.actor, detail: m.detail }] }] };`;
  }

  let repos = 0;
  /** A repository tagged v1.0.0 (refusing A), v1.1.0 (refusing B) and nightly (refusing C), whose working tree then refuses D; with `bare`, a tag holding no table. */
  function repo(bare = false) {
    const root = join(files.root, `repo-${++repos}`);
    mkdirSync(join(root, 'packages/demo/src/logic'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{ "type": "module" }\n');
    if (bare) {
      writeFileSync(join(root, 'README.md'), 'no tables yet\n');
      fixtureCommitAll(root);
      runFixtureGit(['tag', 'v0.9.4'], { cwd: root });
      return root;
    }
    for (const [tag, code] of [['v1.0.0', 'A'], ['v1.1.0', 'B'], ['nightly', 'C']]) {
      writeFileSync(join(root, TABLE), tableSource(code));
      fixtureCommitAll(root);
      runFixtureGit(['tag', tag], { cwd: root });
    }
    writeFileSync(join(root, TABLE), tableSource('D'));
    return root;
  }

  /** The code a table refuses a move with. */
  const refusal = ({ table, rules }) => runTable(table, rules, {}, { name: 'go' }).refused.code;

  test('moves.at-tag-last.resolves-newest-release: clause 1: loadMoveTableAtTag with last returns v1.1.0 and its table, not the newer nightly tag or the working tree [C7,R4,U150]', async () => {
    const released = await loadMoveTableAtTag(repo(), 'demo', 'last');
    assert.equal(released.tag, 'v1.1.0');
    assert.equal(refusal(released), 'B');
    released.dispose();
  });

  test('moves.at-tag-last.no-release-holds-table: clause 2: loadMoveTableAtTag with last is refused JUDGE_TAG naming the table when no release tag holds it [C7,R4,U150]', async () => {
    await assert.rejects(loadMoveTableAtTag(repo(true), 'demo', 'last'), error => error.code === 'JUDGE_TAG' && error.message.includes('demo'));
  });

  /** A board with one recorded claim. */
  function board() {
    const file = join(files.root, `board-${++repos}.sqlite`);
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE event (event_id INTEGER PRIMARY KEY AUTOINCREMENT, event_at TEXT NOT NULL, event_by TEXT NOT NULL, event_kind TEXT NOT NULL, item_id INTEGER, event_detail TEXT NOT NULL DEFAULT '{}')`);
    db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)').run('2026-11-10T00:00:00.000Z', 'core-1', 'claim', 1, '{}');
    db.close();
    return file;
  }

  test('moves.at-tag-last.report-names-resolved-tag: clause 3: replayReport with against last and the setting on reports judge.against as the resolved tag v1.1.0 [C7,R4,U150]', async () => {
    const home = join(files.root, 'machine');
    mkdirSync(home, { recursive: true });
    fixtureMachineSettings(home, { moves: { judgeByRelease: true } });
    const saved = process.env.PULLBOARD_MACHINE_HOME;
    process.env.PULLBOARD_MACHINE_HOME = home;
    try {
      const report = await replayReport({ root: repo(), boardFile: board(), name: 'demo', days: 20, now: NOW, cut: CUT, against: 'last' });
      assert.equal(report.judge.against, 'v1.1.0');
    } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
  });
}
