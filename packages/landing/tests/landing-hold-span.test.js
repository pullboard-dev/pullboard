/** @pullboard-test-input source-tree */
/** A landing refused by a held test defect, or with nothing to select, holds the board for under a second [C7,#3333]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../test/e2e-helpers.js';
import { FIXTURE_MODEL } from '../../../test/e2e-helpers.js';
import { temporaryDirectory } from '../../../test/board-fixture.js';
import { makeLandProjectFixtures } from '../../../test/land-project-fixture.js';
import { runFixtureChild } from '../../../test/fixture-child.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile } = e2e;
const { landProject } = makeLandProjectFixtures({ sandbox, project, commitFile });
const SECOND_MS = 1_000;

/**
 * Run one real landing pass in a child, timing every board write it makes and reading the machine's write log.
 * Why a child: the write log lives in the machine home, which the child points at a private directory.
 */
function landOnce(box, { defect }) {
  const home = temporaryDirectory('hold-span-');
  const url = path => JSON.stringify(pathToFileURL(join(import.meta.dirname, path)).href);
  const source = [
    `import { openBoard } from ${url('../../../apps/lib/index.js')};`,
    `import * as store from ${url('../../../src/board.js')};`,
    `import { loadConfig } from ${url('../../../packages/config/index.js')};`,
    `import { runLandingBatch } from ${url('../index.js')};`,
    `import { landingPorts } from ${url('../../../test/landing-ports-fixture.js')};`,
    `import { checkAtCommit } from ${url('../../../apps/runner/index.js')};`,
    "import { readFileSync, existsSync } from 'node:fs';",
    "import { join } from 'node:path';",
    `import { testBlob } from ${url('../src/shell/landing-step-selection.js')};`,
    `import { mainCheckout } from ${url('../../git/index.js')};`,
    'const [root, home, defect] = process.argv.slice(1);',
    'const board = openBoard(join(root, ".git", "pullboard", "board.sqlite"));',
    'const log = join(home, "board-writes.jsonl");',
    'const rows = () => existsSync(log) ? readFileSync(log, "utf8").split("\\n").filter(Boolean).map(line => JSON.parse(line)) : [];',
    'try {',
    '  if (defect === "1") {',
    '    const blob = testBlob(root, mainCheckout(root).commit, "pullboard.json");',
    '    board.enginePorts.store.recordLandingTestDefect(board, { agentId: "coordinator", test: "pullboard.json", hash: "a".repeat(64), blob, trunkBlob: null, names: ["held"], lane: "web", batchId: "00000000-0000-4000-8000-000000000001", branch: mainCheckout(root).branch });',
    '  }',
    '  const before = rows().length;',
    '  const spans = [];',
    '  const write = async (operation, args) => { const start = performance.now(); try { return board.enginePorts.store[operation](board, ...args); } finally { spans.push({ operation, ms: performance.now() - start }); } };',
    '  let error = null, lines = [];',
    '  try { await runLandingBatch({ landingPorts, checkAtCommit, candidateWorkerFile: "unused", root, board, config: loadConfig(root), owner: "coordinator", write, say: line => lines.push(line), checkLease: async () => {}, checkLeaseNow: () => {} }); }',
    '  catch (caught) { error = { code: caught.code }; }',
    '  console.log(JSON.stringify({ error, lines, spans, writes: rows().slice(before) }));',
    '} finally { store.closeBoard(board); }',
  ].join('\n');
  const run = runFixtureChild(process.execPath, ['--input-type=module', '-e', source, box.repo, home, defect ? '1' : '0'],
    { cwd: box.repo, env: { ...box.env, PULLBOARD_MACHINE_HOME: home }, encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.failure ?? run.stderr}\n${run.stdout}`);
  return JSON.parse(run.stdout.trim().split('\n').at(-1));
}

/** A separate-publish landing project with nothing verified. */
function emptyProject() {
  const box = landProject({ withWorktree: false });
  box.env.PULLBOARD_MODEL = FIXTURE_MODEL;
  return box;
}

test('clause 1: a landing with nothing to select writes nothing and holds the board for no second [C7,#3333]', () => {
  const result = landOnce(emptyProject(), { defect: false });
  assert.equal(result.error, null, JSON.stringify(result));
  assert.deepEqual(result.spans, [], 'selection is read-only, so it opens no board write');
  assert.deepEqual(result.writes.filter(row => row.heldMs >= SECOND_MS), [], 'no recorded hold reaches a second');
});

test('clause 2: a landing refused by LAND_TEST_DEFECT writes nothing and holds the board for no second [C7,#3333]', () => {
  const result = landOnce(emptyProject(), { defect: true });
  assert.equal(result.error?.code, 'LAND_TEST_DEFECT', JSON.stringify(result));
  assert.deepEqual(result.spans.filter(span => span.ms >= SECOND_MS), [], 'no write span reaches a second');
  assert.deepEqual(result.spans, [], 'the refusal is decided before any board write');
  assert.deepEqual(result.writes.filter(row => row.heldMs >= SECOND_MS), [], 'no recorded hold reaches a second');
});
