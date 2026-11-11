/** @pullboard-test-input apps/cli/tests/fixtures/landing/ports.js apps/lib/index.js apps/lib/src/io/landing/candidate.js apps/runner/index.js packages/config/index.js packages/kernel/index.js packages/landing/index.js packages/landing/src/io/step/selection.js packages/store/index.js */
/** Adopted landing batches count every RUNNER_SOURCE attempt and never resume a held item [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../../tests/fixtures/land/project.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile } = e2e;
const { landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures({ sandbox, project, commitFile });

/** A landing project with one accepted item; `separate` lands on the local trunk, otherwise the batch gate pushes. */
function acceptedProject({ separate = false } = {}) {
  const box = landProject();
  if (separate) {
    const path = join(box.repo, 'pullboard.json');
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), landing: { perItem: false, manualOverride: true, publish: 'separate' } }, null, 2));
    box.git(box.repo, 'add', 'pullboard.json');
    box.git(box.repo, 'commit', '-q', '-m', 'chore: land separately');
  }
  const entry = itemWorktree(box, 1);
  submitItem(box, entry);
  acceptItem(box, entry);
  // A landing tree equal to the submit tree reuses the submit receipt and runs no gate; one commit on main first makes the landing gate run (#4259).
  writeFileSync(join(box.repo, 'before-landing.md'), 'before\n');
  box.git(box.repo, 'add', 'before-landing.md');
  box.git(box.repo, 'commit', '-q', '-m', 'docs: main moves before the landing');
  return { box, entry };
}

/** Resolve a repo module to a file URL string for the child's imports. */
function href(path) {
  return JSON.stringify(pathToFileURL(join(import.meta.dirname, path)).href);
}

/**
 * Record an interrupted merging batch for the item at main's tip, then run the real landing `runs` times, adopting
 * whatever batch is still unfinished before each run. `mode` 'source' makes every gate refuse RUNNER_SOURCE; 'hold'
 * holds the verified item before the first run and lifts the hold after the last.
 */
function landRuns(box, entry, { mode, runs }) {
  const source = [
    `import * as store from ${href('../../../../../packages/store/index.js')};`,
    `import { openBoard } from ${href('../../../../lib/index.js')};`,
    `import { loadConfig } from ${href('../../../../../packages/config/index.js')};`,
    `import { runLandingBatch } from ${href('../../../../../packages/landing/index.js')};`,
    `import { candidates } from ${href('../../../../../packages/landing/src/io/step/selection.js')};`,
    `import { Refused } from ${href('../../../../../packages/kernel/index.js')};`,
    `import { landingPorts as ports } from ${JSON.stringify(new URL('../../../tests/fixtures/landing/ports.js', import.meta.url).href)};`,
    `import { checkAtCommit } from ${href('../../../../runner/index.js')};`,
    `const candidateWorkerFile = ${JSON.stringify(join(import.meta.dirname, '../../../../lib/src/io/landing/candidate.js'))};`,
    "import { join } from 'node:path'; import { execFileSync } from 'node:child_process'; import { mkdirSync } from 'node:fs';",
    'const [root, itemId, commit, mode, runs] = process.argv.slice(1);',
    'const board = openBoard(join(root, ".git", "pullboard", "board.sqlite"));',
    'const lines = [], errors = [], adopted = [];',
    'try {',
    'const write = async (operation, args) => board.enginePorts.store[operation](board, ...args);',
    'const landingPorts = mode === "source" ? { ...ports, quarantineVerdictSnapshot() { throw new Refused("RUNNER_SOURCE", "the runner checkout is not the queued candidate"); } } : ports;',
    'const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();',
    'const id = "00000000-0000-4000-8000-000000000002", directory = join(root, ".git", "pullboard", "landings", id), worktree = join(directory, "worktree");',
    'mkdirSync(directory, { recursive: true }); execFileSync("git", ["worktree", "add", "-q", "--detach", worktree, base], { cwd: root });',
    'const entry = { id: Number(itemId), commit };',
    'await write("recordLandingBatch", [{ agentId: "coordinator", batch: { version: 1, id, startedAt: new Date().toISOString(), base, tip: base, branch: "refs/heads/main", root: worktree, candidates: [entry], items: [entry], conflicts: [], blocked: [], state: "merging", owner: "coordinator", pid: 999999, host: "fixture", logPath: join(directory, "logs", "batch.log"), revision: 0 } }]);',
    'if (mode === "hold") store.holdItem(board, entry.id, { agentId: "coordinator", reason: "landing keeps dying on this item" });',
    'for (let run = 0; run < Number(runs); run++) {',
    '  const unfinished = store.landingBatches(board).findLast(row => row.state !== "landed" && row.state !== "blocked");',
    '  adopted.push(unfinished?.id ?? null);',
    '  try { await runLandingBatch({ landingPorts, checkAtCommit, candidateWorkerFile, root, board, config: loadConfig(root), owner: "coordinator", adopt: Boolean(unfinished), write, say: line => lines.push(line), checkLease: async () => {}, checkLeaseNow: () => {} }); }',
    '  catch (failure) { errors.push(failure.code ?? String(failure)); }',
    '}',
    'const heldStatus = store.getItem(board, entry.id).item_status;',
    'const selectedHeld = candidates(board, root, base, 8, { landingPorts: ports });',
    'if (mode === "hold") store.releaseItemHold(board, entry.id, { agentId: "coordinator" });',
    'const selectedAfter = candidates(board, root, base, 8, { landingPorts: ports });',
    'const batches = store.landingBatches(board);',
    'console.log("RESULT " + JSON.stringify({ errors, lines, adopted, heldStatus, batch: batches.find(row => row.id === id), others: batches.filter(row => row.id !== id).length,',
    '  merged: store.getItem(board, entry.id).item_merged_commit, blocked: selectedHeld.blocked, ready: selectedHeld.ready.map(item => item.item_id), readyAfter: selectedAfter.ready.map(item => item.item_id) }));',
    '} finally { store.closeBoard(board); }',
  ].join('\n');
  const run = runFixtureChild(process.execPath, ['--input-type=module', '-e', source, box.repo, String(entry.item), entry.commit, mode, String(runs)],
    { cwd: box.repo, env: { ...box.env }, encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.failure ?? run.stderr}\n${run.stdout}`);
  return JSON.parse(run.stdout.split('\n').find(line => line.startsWith('RESULT ')).slice('RESULT '.length));
}

test('clause 2: an adopted batch refused RUNNER_SOURCE three times stops blocked, holds its item with the reason and starts nothing more [C7]', () => {
  const { box, entry } = acceptedProject();
  const result = landRuns(box, entry, { mode: 'source', runs: 5 });
  const id = '00000000-0000-4000-8000-000000000002';
  assert.deepEqual(result.adopted, [id, null, null, null, null], `the first run adopts the fixture batch; d614aab905 returns a refused one-item batch to its item, so later runs start fresh batches: ${JSON.stringify({ errors: result.errors, lines: result.lines, batch: result.batch })}`);
  assert.equal(result.errors.filter(code => code === 'RUNNER_SOURCE').length, 3, `exactly three attempts, then no loop: ${JSON.stringify({ errors: result.errors, lines: result.lines, others: result.others, merged: result.merged, batch: result.batch?.state })}`);
  assert.equal(result.batch.refusals.length, 1, 'each refused one-item batch keeps its own refusal');
  assert.ok(result.batch.refusals.every(refusal => refusal.code === 'RUNNER_SOURCE' && refusal.message === 'the runner checkout is not the queued candidate'), JSON.stringify(result.batch.refusals));
  assert.equal(result.batch.state, 'blocked', 'nothing adopts it again');
  const held = result.blocked.find(row => row.id === entry.item);
  assert.equal(held.code, 'LAND_RUNNER_SOURCE_HELD');
  assert.match(held.message, /3 landing attempts were refused RUNNER_SOURCE \(the runner checkout is not the queued candidate\)/u);
  assert.equal(result.others, 2, 'two fresh batches follow the first, then none for the held item');
  assert.equal(result.merged, null);
  assert.deepEqual(result.ready, [], 'selection keeps the item out until its head or main changes');
});

test('trunk landing records each RUNNER_SOURCE refusal and starts no fourth batch [C7]', () => {
  const { box, entry } = acceptedProject({ separate: true });
  const result = landRuns(box, entry, { mode: 'source', runs: 5 });
  assert.equal(result.batch.state, 'blocked');
  assert.deepEqual(result.batch.refusals.map(refusal => [refusal.code, refusal.message]), [['RUNNER_SOURCE', 'the runner checkout is not the queued candidate']]);
  assert.equal(result.others, 2, `two fresh batches after the first, then none: ${JSON.stringify(result.lines)}`);
  assert.equal(result.merged, null);
  assert.deepEqual(result.ready, []);
  assert.match(result.blocked.find(row => row.id === entry.item)?.message ?? '', /3 landing attempts were refused RUNNER_SOURCE/u);
});

test('an adopted batch carrying a held verified item is retired, the item keeps its accept, and hold --off returns it [C7]', () => {
  const { box, entry } = acceptedProject();
  const result = landRuns(box, entry, { mode: 'hold', runs: 1 });
  assert.equal(result.batch.state, 'blocked', JSON.stringify(result.batch));
  assert.deepEqual(result.batch.blocked.filter(row => row.id === entry.item).map(row => [row.code, row.message]), [['ITEM_HELD', 'landing keeps dying on this item']]);
  assert.equal(result.merged, null, 'the held item does not land through the adopted batch');
  assert.equal(result.others, 0, 'no fresh batch takes the held item');
  assert.equal(result.heldStatus, 'verified', 'the hold keeps its accept');
  assert.deepEqual(result.ready, []);
  assert.deepEqual(result.readyAfter, [entry.item], 'hold --off returns it to landing');
});

/**
 * Land the item on the local trunk until the batch saves 'trunk', then crash before its receipts or trunk move; hold
 * the item, adopt the crashed batch, lift the hold and land again, reporting main and the item at each step.
 */
function trunkCrashRuns(box, entry) {
  const source = [
    `import * as store from ${href('../../../../../packages/store/index.js')};`,
    `import { openBoard } from ${href('../../../../lib/index.js')};`,
    `import { loadConfig } from ${href('../../../../../packages/config/index.js')};`,
    `import { runLandingBatch } from ${href('../../../../../packages/landing/index.js')};`,
    `import { landingPorts } from ${JSON.stringify(new URL('../../../tests/fixtures/landing/ports.js', import.meta.url).href)};`,
    `import { checkAtCommit } from ${href('../../../../runner/index.js')};`,
    `const candidateWorkerFile = ${JSON.stringify(join(import.meta.dirname, '../../../../lib/src/io/landing/candidate.js'))};`,
    "import { join } from 'node:path'; import { execFileSync } from 'node:child_process';",
    'const [root, itemId] = process.argv.slice(1), id = Number(itemId);',
    'const board = openBoard(join(root, ".git", "pullboard", "board.sqlite"));',
    'const head = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();',
    'const item = () => { const row = store.getItem(board, id); return { status: row.item_status, merged: row.item_merged_commit }; };',
    'let crashAtTrunk = true; const lines = [], errors = [];',
    'const write = async (operation, args) => {',
    '  const result = board.enginePorts.store[operation](board, ...args);',
    '  if (crashAtTrunk && operation === "recordLandingBatch" && args[0].batch.state === "trunk") { crashAtTrunk = false; throw Object.assign(new Error("crash after saving trunk"), { code: "FIXTURE_CRASH" }); }',
    '  return result;',
    '};',
    'const land = async adopt => { try { return await runLandingBatch({ landingPorts, checkAtCommit, candidateWorkerFile, root, board, config: loadConfig(root), owner: "coordinator", adopt, write, say: line => lines.push(line), checkLease: async () => {}, checkLeaseNow: () => {} }); } catch (failure) { errors.push(failure.code ?? String(failure)); return null; } };',
    'try {',
    'const base = head();',
    'await land(false);',
    'const crashed = store.landingBatches(board).at(-1);',
    'const atCrash = { state: crashed.state, main: head(), ...item() };',
    'store.holdItem(board, id, { agentId: "coordinator", reason: "hold the crashed trunk batch" });',
    'await land(true);',
    'const retired = store.landingBatches(board).find(row => row.id === crashed.id);',
    'const afterAdopt = { state: retired.state, blocked: retired.blocked, main: head(), batches: store.landingBatches(board).length, ...item() };',
    'store.releaseItemHold(board, id, { agentId: "coordinator" });',
    'await land(false);',
    'const afterOff = { main: head(), ...item() };',
    'console.log("RESULT " + JSON.stringify({ base, errors, lines, atCrash, afterAdopt, afterOff }));',
    '} finally { store.closeBoard(board); }',
  ].join('\n');
  const run = runFixtureChild(process.execPath, ['--input-type=module', '-e', source, box.repo, String(entry.item)],
    { cwd: box.repo, env: { ...box.env }, encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.failure ?? run.stderr}\n${run.stdout}`);
  return JSON.parse(run.stdout.split('\n').find(line => line.startsWith('RESULT ')).slice('RESULT '.length));
}

test('a trunk batch that crashed before its receipts is retired when its item is held: main stays, the accept stays, and hold --off lands it [C7]', () => {
  const { box, entry } = acceptedProject({ separate: true });
  const result = trunkCrashRuns(box, entry);
  const trace = JSON.stringify(result);
  assert.equal(result.atCrash.state, 'trunk', `the crash leaves the batch saved as trunk: ${trace}`);
  assert.equal(result.atCrash.main, result.base, 'the crash comes before the trunk move');
  assert.deepEqual([result.atCrash.status, result.atCrash.merged], ['verified', null], 'and before the merged receipts');
  assert.equal(result.afterAdopt.state, 'blocked', `adoption retires the held trunk batch: ${trace}`);
  assert.deepEqual(result.afterAdopt.blocked.filter(row => row.id === entry.item).map(row => row.code), ['ITEM_HELD']);
  assert.equal(result.afterAdopt.main, result.base, 'main does not move for a held item');
  assert.deepEqual([result.afterAdopt.status, result.afterAdopt.merged], ['verified', null], 'the held item keeps its accept and stays unmerged');
  assert.equal(result.afterAdopt.batches, 1, 'no fresh batch takes the held item');
  assert.notEqual(result.afterOff.main, result.base, `hold --off lands it on the local trunk: ${trace}`);
  assert.equal(result.afterOff.merged, result.afterOff.main, 'with its merged receipt at the new trunk head');
});
