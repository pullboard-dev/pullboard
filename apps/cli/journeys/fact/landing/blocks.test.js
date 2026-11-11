/** @pullboard-test-input source-tree */
/** Every refusal or crash in a landing step ends its batch blocked, recorded once, so no restart adopts it unchanged [C7]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../../tests/fixtures/land/project.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';
import { boardFixture } from '../../../tests/fixtures/next/order.js';
import * as store from '../../../../../packages/store/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import {
  blockAfterRefusal,
  crashRefusal,
} from '../../../../../packages/landing/index.js';

/** A gating batch on a real board, with a write port that applies the batch moves as the worker's parent would. */
function gating(t, id) {
  const { board } = boardFixture();
  t.after(() => store.closeBoard(board));
  const state = { board, say() {}, write: async (operation, args) => store[operation](board, ...args), batch: null };
  state.batch = store.recordLandingBatch(board, { agentId: 'coordinator', revision: 0, batch: { version: 1, id, state: 'gating',
    base: 'a'.repeat(40), tip: 'b'.repeat(40), root: '/fixture', branch: 'refs/heads/main', owner: 'coordinator', logPath: '/fixture/log', items: [], candidates: [], conflicts: [] } });
  return { state, latest: () => store.landingBatches(board).find(batch => batch.id === id) };
}

for (const [step, code] of [['merge', 'LAND_MERGE'], ['gate', 'GATE_RED'], ['diagnose', 'LAND_DIAGNOSE'], ['trunk', 'LAND_TRUNK'], ['publish', 'LAND_PUBLISH']]) {
  test(`clause 1: a ${step} refusal ends the batch blocked with its code [C7]`, async t => {
    const { state, latest } = gating(t, `refuse-${step}`);
    await blockAfterRefusal(state, new Refused(code, `${step} refused`));
    assert.equal(latest().state, 'blocked');
  });
}

test('clause 1: a lost lease keeps the batch for adoption, a board-busy refusal blocks it like any other [C7]', async t => {
  const lost = gating(t, 'keep-lost');
  await blockAfterRefusal(lost.state, new Refused('LAND_LEASE_LOST', 'lost'));
  assert.equal(lost.latest().state, 'gating');
  const busy = gating(t, 'block-busy');
  await blockAfterRefusal(busy.state, new Refused('BOARD_BUSY', 'busy'));
  assert.equal(busy.latest().state, 'blocked');
});

test('clause 2: a non-refusal crash is recorded blocked as LAND_WORKER_CRASH with its stack, once [C7]', async t => {
  const { state, latest } = gating(t, 'crash-once');
  const error = new TypeError('boom');
  const refusal = crashRefusal(error);
  assert.equal(refusal.code, 'LAND_WORKER_CRASH');
  assert.match(refusal.message, /TypeError: boom[\s\S]*at /u);
  await blockAfterRefusal(state, error);
  await blockAfterRefusal(state, error);
  assert.equal(latest().state, 'blocked');
});

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile } = e2e;
const { landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures({ sandbox, project, commitFile });

/** A landing project with two accepted items (the second red when `red`); `separate` lands on the local trunk, otherwise the batch gate pushes. */
function twoAccepted({ separate = false, red = false } = {}) {
  const box = landProject();
  if (separate) {
    const path = join(box.repo, 'pullboard.json');
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), landing: { perItem: false, manualOverride: true, publish: 'separate' } }, null, 2));
    box.git(box.repo, 'add', 'pullboard.json');
    box.git(box.repo, 'commit', '-q', '-m', 'chore: land separately');
  }
  // The fixture gate suppresses its red while the red item is submitted and accepted, then the landing gate sees it.
  box.env.LAND_SUPPRESS_RED = '1';
  const entries = [1, 2].map(number => {
    const entry = itemWorktree(box, number);
    submitItem(box, entry, red && number === 2 ? 'RED\n' : 'PASS\n');
    acceptItem(box, entry);
    return entry;
  });
  delete box.env.LAND_SUPPRESS_RED;
  return { box, entries };
}

/** Resolve a repo module to a file URL string for the child's imports. */
function href(path) {
  return JSON.stringify(pathToFileURL(join(import.meta.dirname, path)).href);
}

/**
 * Run the real landing twice on the project with `step` refusing through the port that step calls (or, for diagnose, a
 * diagnostic runner that dirties the landing worktree), reporting the first run's batch and whether the second run
 * found a batch left to adopt.
 */
function landWithRefusal(box, step) {
  const source = [
    `import * as store from ${href('../../../../../packages/store/index.js')};`,
    `import { openBoard } from ${href('../../../../lib/index.js')};`,
    `import { loadConfig } from ${href('../../../../../packages/config/index.js')};`,
    `import { runLandingBatch } from ${href('../../../../../packages/landing/index.js')};`,
    `import { Refused } from ${href('../../../../../packages/kernel/index.js')};`,
    `import { landingPorts as ports } from ${JSON.stringify(new URL('../../../tests/fixtures/landing/ports.js', import.meta.url).href)};`,
    `import { checkAtCommit } from ${href('../../../../runner/index.js')};`,
    `const candidateWorkerFile = ${JSON.stringify(join(import.meta.dirname, '../../../../lib/src/io/landing/candidate.js'))};`,
    "import { join } from 'node:path';",
    'const [root, step] = process.argv.slice(1);',
    'const board = openBoard(join(root, ".git", "pullboard", "board.sqlite"));',
    'const lines = [], errors = [];',
    'const refuse = (code) => () => { throw new Refused(code, `fixture ${step} refusal`); };',
    'const wrap = { merge: { badgeCounts: refuse("LAND_MERGE") }, gate: { quarantineVerdictSnapshot: refuse("GATE_RED") },',
    '  trunk: { landingFlakeRatchet: refuse("LAND_TRUNK") }, publish: { validateQuarantineLandingProof: refuse("LAND_PUBLISH") }, diagnose: {}, crash: { badgeCounts: () => { throw new TypeError("fixture crash"); } } }[step];',
    'const landingPorts = { ...ports, ...wrap };',
    'try {',
    'const write = async (operation, args) => board.enginePorts.store[operation](board, ...args);',
    'let config = loadConfig(root);',
    'if (step === "diagnose") config = { ...config, affectedTests: "echo changed >> pullboard.json" };',
    'const land = async () => { try { await runLandingBatch({ landingPorts, checkAtCommit, candidateWorkerFile, root, board, config, owner: "coordinator", write, say: line => lines.push(line), checkLease: async () => {}, checkLeaseNow: () => {} }); } catch (failure) { errors.push({ code: failure.code ?? failure.name, message: String(failure.message) }); } };',
    'await land();',
    'const first = store.landingBatches(board).map(row => ({ id: row.id, state: row.state, items: row.items.length, refusals: row.refusals ?? [], refusal: row.refusal ?? null }));',
    'const firstErrors = errors.slice();',
    'const unfinished = store.landingBatches(board).filter(row => row.state !== "landed" && row.state !== "blocked").length;',
    'await land();',
    'const second = store.landingBatches(board).map(row => ({ id: row.id, state: row.state }));',
    'console.log("RESULT " + JSON.stringify({ first, firstErrors, unfinished, errors, lines, second }));',
    '} finally { store.closeBoard(board); }',
  ].join('\n');
  const run = runFixtureChild(process.execPath, ['--input-type=module', '-e', source, box.repo, step], { cwd: box.repo, env: { ...box.env }, encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.failure ?? run.stderr}\n${run.stdout}`);
  return JSON.parse(run.stdout.split('\n').find(line => line.startsWith('RESULT ')).slice('RESULT '.length));
}

for (const [step, code, options] of [['merge', 'LAND_MERGE', {}], ['gate', 'GATE_RED', {}], ['diagnose', 'LAND_SOURCE_CHANGED', { red: true }],
  ['trunk', 'LAND_TRUNK', { separate: true }], ['publish', 'LAND_PUBLISH', {}]]) {
  test(`clause 1 end to end: a refusal raised in the ${step} step of a real two-item landing is recorded blocked with its code and message, and the next run starts a new batch [C7]`, () => {
    const { box } = twoAccepted(options);
    const result = landWithRefusal(box, step);
    const trace = JSON.stringify(result);
    const batch = result.first[0];
    assert.equal(batch.items, 2, `one batch of both items: ${trace}`);
    assert.equal(batch.state, 'blocked', trace);
    assert.ok(batch.refusals.some(refusal => refusal.code === code && refusal.message.length > 0), `the batch records ${code}: ${trace}`);
    if (step !== 'diagnose') assert.ok(batch.refusals.some(refusal => refusal.message === `fixture ${step} refusal`), `with its message: ${trace}`);
    assert.equal(result.unfinished, 0, `nothing is left for adoption: ${trace}`);
    assert.ok(!result.errors.some(error => error.code === 'LAND_ADOPT'), `the next run is not told to adopt: ${trace}`);
    assert.ok(result.second.length > 1, `the next run started a new batch: ${trace}`);
  });
}

test('clause 2 end to end: a non-refusal crash in a real landing is recorded blocked as LAND_WORKER_CRASH with its stack, once, and is not adopted again [C7]', () => {
  const { box } = twoAccepted();
  const result = landWithRefusal(box, 'crash');
  const trace = JSON.stringify(result);
  const batch = result.first[0];
  assert.equal(batch.state, 'blocked', trace);
  assert.equal(batch.refusals.filter(refusal => refusal.code === 'LAND_WORKER_CRASH').length, 1, `recorded once: ${trace}`);
  assert.match(batch.refusals.find(refusal => refusal.code === 'LAND_WORKER_CRASH').message, /TypeError: fixture crash[\s\S]*at /u);
  assert.equal(result.unfinished, 0, `not adopted again: ${trace}`);
  assert.ok(!result.errors.some(error => error.code === 'LAND_ADOPT'), trace);
});
