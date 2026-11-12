/** @pullboard-test-input apps/cli/tests/fixtures/landing/ports.js apps/lib/index.js apps/lib/src/io/landing/candidate.js apps/runner/index.js packages/config/index.js packages/git/index.js packages/landing/index.js packages/landing/src/io/step/selection.js packages/store/index.js */
/** A landing beside a recorded test defect, or with nothing to select, holds the board for under a second [C7,#3333]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { FIXTURE_MODEL } from '../../tests/fixtures/e2e.js';
import { temporaryDirectory } from '../../tests/fixtures/board.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile } = e2e;
const { landProject, itemWorktree, submitItem, acceptItem, moveMainPastSubmit } = makeLandProjectFixtures({ sandbox, project, commitFile });
const SECOND_MS = 1_000;

/**
 * Run one real landing pass in a child, timing every board write it makes and reading the machine's write log.
 * Why a child: the write log lives in the machine home, which the child points at a private directory.
 */
function landOnce(box, { defect }) {
  const home = temporaryDirectory('hold-span-');
  const url = path => JSON.stringify(pathToFileURL(join(import.meta.dirname, path)).href);
  const source = [
    `import { openBoard } from ${url('../../../lib/index.js')};`,
    `import * as store from ${url('../../../../packages/store/index.js')};`,
    `import { writeBoardCommand } from ${url('../../../../packages/store/index.js')};`,
    `import { loadConfig } from ${url('../../../../packages/config/index.js')};`,
    `import { runLandingBatch } from ${url('../../../../packages/landing/index.js')};`,
    `import { landingPorts } from ${url('../../tests/fixtures/landing/ports.js')};`,
    `import { checkAtCommit } from ${url('../../../runner/index.js')};`,
    "import { readFileSync, existsSync } from 'node:fs';",
    "import { join } from 'node:path';",
    `import { testBlob } from ${url('../../../../packages/landing/src/io/step/selection.js')};`,
    `import { mainCheckout } from ${url('../../../../packages/git/index.js')};`,
    'const [root, home, defect] = process.argv.slice(1);',
    'const board = openBoard(join(root, ".git", "pullboard", "board.sqlite"), undefined, { writeContext: { command: "api", seat: "coordinator" } });',
    'const log = join(home, "board-writes.jsonl");',
    'const rows = () => existsSync(log) ? readFileSync(log, "utf8").split("\\n").filter(Boolean).map(line => JSON.parse(line)) : [];',
    'try {',
    '  if (defect === "1") {',
    '    const blob = testBlob(root, mainCheckout(root).commit, "pullboard.json");',
    '    board.enginePorts.store.recordLandingTestDefect(board, { agentId: "coordinator", test: "pullboard.json", hash: "a".repeat(64), blob, trunkBlob: null, names: ["held"], lane: "web", batchId: "00000000-0000-4000-8000-000000000001", branch: mainCheckout(root).branch });',
    '  }',
    '  const before = rows().length;',
    '  const spans = [];',
    '  const write = async (operation, args) => { const start = performance.now(); try { return writeBoardCommand(board, operation, args, "coordinator"); } finally { spans.push({ operation, ms: performance.now() - start }); } };',
    '  let error = null, lines = [];',
    '  try { await runLandingBatch({ landingPorts, checkAtCommit, candidateWorkerFile: process.argv[4], root, board, config: loadConfig(root), owner: "coordinator", write, say: line => lines.push(line), checkLease: async () => {}, checkLeaseNow: () => {} }); }',
    '  catch (caught) { error = { code: caught.code }; }',
    '  console.log(JSON.stringify({ error, lines, spans, writes: rows().slice(before) }));',
    '} finally { store.closeBoard(board); }',
  ].join('\n');
  const run = runFixtureChild(process.execPath, ['--input-type=module', '-e', source, box.repo, home, defect ? '1' : '0', join(import.meta.dirname, '../../../lib/src/io/landing/candidate.js')],
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

test('clause 2: a recorded test defect no longer refuses a landing, which writes nothing and holds the board for no second [C7,#3333,#5862]', () => {
  const result = landOnce(emptyProject(), { defect: true });
  assert.equal(result.error, null, `a defect is a repair item, never a trunk hold: ${JSON.stringify(result)}`);
  assert.deepEqual(result.spans.filter(span => span.ms >= SECOND_MS), [], 'no write span reaches a second');
  assert.deepEqual(result.spans, [], 'with nothing to select, the landing opens no board write');
  assert.deepEqual(result.writes.filter(row => row.heldMs >= SECOND_MS), [], 'no recorded hold reaches a second');
});

test('clause 1: a real landing that selects, admits and records its batch opens its board writes only to record, each under a second [C7,#3333]', () => {
  const box = emptyProject();
  // The item's own check passed with the fixture's red suppressed; main then moves, so the landing runs its real gate.
  box.env.LAND_SUPPRESS_RED = '1';
  let entry;
  try {
    entry = itemWorktree(box, 1);
    submitItem(box, entry, '// PASS\n');
    acceptItem(box, entry);
  } finally { delete box.env.LAND_SUPPRESS_RED; }
  moveMainPastSubmit(box, 1);
  const result = landOnce(box, { defect: false });
  assert.equal(result.error, null, `${JSON.stringify(result.error)}\n${result.lines.join('\n')}`);
  const operations = result.spans.map(span => span.operation);
  assert.ok(operations.length > 0 && operations.includes('recordLandingBatch'), `the landing records its batch: ${operations.join(', ')}`);
  assert.equal(operations[0], 'recordLandingBatch', 'selection, test-defect checks, admission and the gate ran before the first board write, which is the batch record');
  assert.deepEqual(result.spans.filter(span => span.ms >= SECOND_MS), [], 'no write span of a landing that records reaches a second');
  assert.ok(result.writes.length > 0, 'the machine write log recorded this landing\'s holds');
  const api = result.writes.filter(row => row.command === 'api' && row.seat === 'coordinator' && row.phase === 'native-move');
  assert.ok(api.some(row => row.move === 'recordLandingBatch'), `a command=api seat=coordinator phase=native-move hold receipt names the batch record: ${JSON.stringify(result.writes)}`);
  assert.deepEqual(api.filter(row => row.heldMs >= SECOND_MS), [], 'every api/coordinator/native-move hold is under a second');
  assert.deepEqual(result.writes.filter(row => row.heldMs >= SECOND_MS), [], 'no recorded hold reaches a second');
});
