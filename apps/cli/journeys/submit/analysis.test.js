/** A queued submit's analysis runs on a runner with main's committed tooling; the controller only queues and records [V4,C7]. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { remoteSubmitAnalysis } from '../../src/io/submit/gate.js';
import { remoteGateWanted } from '../../src/io/submit/gate.js';
import { submitUntilSettled } from '../../../lib/src/io/submit/requeue.js';

/** The real scope and memo module, which a scoped fixture's main re-exports from its gate front door [5814]. */
const SCOPE = new URL('../../../../packages/gate/src/io/static/scope.js', import.meta.url).href;

// Captured before any patching, so the fake runner's own processes never count as the controller's.
const unpatchedExecFileSync = childProcess.execFileSync;
const KEEP = new Set(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']);

/** A Git environment free of the caller's repository selectors and identity. */
function gitEnv() {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !KEEP.has(key)) delete env[key];
  return env;
}

/** The fake trusted tooling records each step, where it ran and which file ran it, in the checkout it inspected. */
const RECORD = `import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
export function record(root, step, url) { appendFileSync(join(root, '.git', 'trusted-steps.jsonl'), JSON.stringify({ step, root, url, pid: process.pid }) + '\\n'); }
`;

/**
 * Build a controller repository whose main holds recording tooling and whose candidate replaces every tool with a bomb,
 * plus a separate runner clone checked out at the candidate.
 */
function fixture(t, { red = false, flaky = 0, brokenMain = false, cellsPlan = false, warmFails = false, scoped = false, wholeRepo = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'submit-remote-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...gitEnv(), PULLBOARD_MACHINE_HOME: join(dir, 'home') };
  const controller = join(dir, 'controller');
  const runner = join(dir, 'runner');
  mkdirSync(controller);
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  const put = (path, body) => { const file = join(controller, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, body); };
  git(controller, 'init', '--quiet', '--initial-branch=main');
  git(controller, 'config', 'pullboard.trunk', 'refs/heads/main');
  put('package.json', '{"type":"module"}\n');
  put('bin/record.js', RECORD);
  put('packages/items/index.js', `import { record } from '../../bin/record.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export function requirePlannedSource(root) {
  record(root, 'placement', import.meta.url);
  const seen = join(root, '.git', 'placement-reads');
  const reads = existsSync(seen) ? Number(readFileSync(seen, 'utf8')) : 0;
  writeFileSync(seen, String(reads + 1));
  if (reads < ${flaky}) throw Object.assign(new Error('the accepted cells-plan presence could not be read from Git'), { name: 'GitReadInfrastructureError', code: 'GIT_READ_INFRASTRUCTURE', retryable: true });
}
export function requireSubmitComposition(root) { record(root, 'composition', import.meta.url); }
`);
  put('packages/gate/index.js', `import { record } from '../../bin/record.js';
export function importsIn() {} export function commonJsIn() {} export function withImportParseCache() {}
export function foreignNodeOptions() { return false; }
export function submitGatePlan(root, config, options) {
  record(root, 'selection', import.meta.url);
  return { check: options.check, selection: { full: false, reason: 'fixture', files: ['test/a.test.js'] }, deferred: false, deferFullFallback: false,
    deferSelection: false, invariants: [], registryGuards: [], proofFiles: ['test/a.test.js'], fullConfig: config, hasFinalProof: true,
    proofCommand: config.affectedTests + ' ./test/a.test.js', phases: [], testTiers: null, testRunner: config.affectedTests };
}
export async function submitGateAdmission(root) { record(root, 'admission', import.meta.url); return { browser: false, gui: false }; }
${scoped ? `export * from ${JSON.stringify(SCOPE)};\n` : ''}${cellsPlan ? `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export function readAcceptedCells(root, commit) {
  const file = join(root, '.git', 'produced-' + commit);
  return existsSync(file) ? { available: true, commit, produced: readFileSync(file, 'utf8') } : { available: false, cause: 'missing-artifact' };
}
export async function warmAcceptedCells(root, commit, { withCheckout, withLock, trunk }) {
  record(root, 'inventory', import.meta.url);
  if (typeof withCheckout !== 'function' || typeof withLock !== 'function') throw new Error('missing ports');
  if (${warmFails}) throw new Error('fixture producer failed');
  writeFileSync(join(root, '.git', 'produced-' + commit), 'trunk ' + trunk);
}
` : ''}`);
  put('packages/landing/index.js', 'export function withMainCheckout() {}\n');
  if (cellsPlan) {
    put('packages/codemap/data/plan/cells.json', '{}\n');
    put('packages/outbox/index.js', 'export function withFileLock() {}\n');
  }
  put('bin/cells-submit-checks.js', `${brokenMain ? "import { transferredCellsInventories } from './record.js';\n" : ''}import { record } from './record.js';
export async function requireSubmitCells(root, main, source, item, services) {
  record(root, 'cells', import.meta.url);
  if (JSON.parse(item.item_frozen).criterion !== 'fixture criterion' || services.readCutItems()[0].item_id !== 7) throw new Error('lost authority');
  return { acceptedMain: main, source, cells: ['trusted-main', ...(services.acceptedArtifact ? ['inventory ' + services.acceptedArtifact.produced] : [])], existingCuts: [] };
}
`);
  put('packages/codemap/src/io/cells/scripts/cache.js', 'export function transferredCellsInventories() { return null; }\n');
  put('apps/cli/src/io/static/checks.js', `import { existsSync } from 'node:fs';
import { record } from '../../../../../bin/record.js';
import { appendFileSync } from 'node:fs';
record(process.cwd(), 'static', import.meta.url);
appendFileSync('.git/static-scope.jsonl', (process.env.PULLBOARD_STATIC_SCOPE ?? 'null') + '\\n');
if (existsSync('RED')) { console.error('src/thing.js:1 one import binding per line'); process.exitCode = 1; }
`);
  git(controller, 'add', '.');
  git(controller, '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'trusted main');
  const main = git(controller, 'rev-parse', 'HEAD');
  const bomb = "throw new Error('candidate tooling was executed');\n";
  for (const path of ['bin/record.js', 'bin/cells-submit-checks.js', 'packages/codemap/src/io/cells/scripts/cache.js', 'apps/cli/src/io/static/checks.js', 'packages/items/index.js', 'packages/gate/index.js', 'packages/landing/index.js']) put(path, bomb);
  put('src/thing.js', 'export const thing = 1;\n');
  if (red) put('RED', 'candidate data\n');
  if (wholeRepo) put('package.json', '{"type":"module","private":true}\n');
  git(controller, 'add', '.');
  git(controller, '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'candidate');
  const source = git(controller, 'rev-parse', 'HEAD');
  git(dir, 'clone', '--quiet', '--no-checkout', controller, runner);
  git(runner, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', source);
  return { dir, controller, runner, main, source, tree: git(controller, 'rev-parse', `${source}^{tree}`), env };
}

/** A runner transport that executes the private check in the runner clone and returns its authenticated receipt. */
function fakeRunner(box, { tamper = false } = {}) {
  const run = unpatchedExecFileSync;
  const runOnRunnerAsync = async (_root, shell, options) => {
    let bytes;
    let code = 0;
    try { bytes = run('/bin/sh', ['-c', shell], { cwd: box.runner, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { bytes = Buffer.concat([error.stdout ?? Buffer.alloc(0), error.stderr ?? Buffer.alloc(0)]); code = error.status ?? 1; }
    writeFileSync(options.rawOutputPath, bytes);
    const sha256 = tamper ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex');
    return { executionRunner: 'runner-1', executionSource: { commit: box.source, tree: box.tree }, rawOutputPath: options.rawOutputPath,
      privateCheck: { receipt: { requestSha256: options.privateCheck.sha256, sourceUnchanged: true,
        phases: { check: { offset: 0, length: bytes.length, code, signal: null, timedOut: false, sha256 } } } } };
  };
  return { runner: { host: 'runner-1', node: process.execPath }, source: { commit: box.source, tree: box.tree },
    executionServices: { runners: { runOnRunnerAsync } } };
}

/** Record every process this controller starts while `work` runs; the fake runner keeps its own unpatched reference. */
async function controllerSpawns(work) {
  const names = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'];
  const original = Object.fromEntries(names.map(name => [name, childProcess[name]]));
  const seen = [];
  for (const name of names) childProcess[name] = (command, ...rest) => { seen.push([command, ...(Array.isArray(rest[0]) ? rest[0] : [])].join(' ')); return original[name](command, ...rest); };
  syncBuiltinESMExports();
  try { return { value: await work(), seen }; }
  finally {
    Object.assign(childProcess, original);
    syncBuiltinESMExports();
  }
}

/** The request a queued worker sends: pinned commits, its config and the board's cut rows, all as data. */
function request(box, readCutItems = () => [{ item_id: 7 }]) {
  return { main: box.main, source: box.source, trunk: box.main, base: box.main, check: 'node --test test/a.test.js', criterion: 'fixture criterion',
    composition: box.source, staticChecks: 'node apps/cli/src/io/static/checks.js', config: { affectedTests: 'node apps/cli/src/io/run/tests.js', gate: 'npm test' },
    browserFreeChecks: true, readCutItems };
}

test('a queued submit runs placement, static, composition, cells and selection on the runner with main tooling; the controller runs only git [V4,C7]', async t => {
  const box = fixture(t);
  const artifacts = join(box.dir, 'artifacts');
  const { value, seen } = await controllerSpawns(() => remoteSubmitAnalysis(box.controller, request(box), fakeRunner(box), artifacts));
  assert.deepEqual(value.cells.cells, ['trusted-main']);
  assert.deepEqual(value.plan.proofFiles, ['test/a.test.js']);
  assert.deepEqual(value.admission, { browser: false, gui: false });
  assert.deepEqual(Object.keys(value.steps), ['placement', 'static', 'composition', 'cells', 'selection', 'admission']);
  assert.equal(value.runner, 'runner-1');
  // Every analysis step ran in the runner's checkout of the candidate, from main's archive, never from candidate files.
  const steps = readFileSync(join(box.runner, '.git', 'trusted-steps.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(steps.map(row => row.step), ['placement', 'static', 'composition', 'cells', 'selection', 'admission']);
  for (const row of steps) {
    assert.equal(realpathSync(row.root), realpathSync(box.runner)); // a step's own cwd is the real path of a symlinked temp folder
    assert.match(row.url, /pullboard-trusted-main-/u);
    assert.notEqual(row.pid, process.pid);
  }
  // The controller performed no cells or static analysis: no ledger in its checkout and no process but git.
  assert.equal(existsSync(join(box.controller, '.git', 'trusted-steps.jsonl')), false);
  assert.ok(seen.length > 0, 'the controller resolves the candidate tree with git');
  assert.deepEqual(seen.filter(command => basename(command.split(' ')[0]) !== 'git'), []);
  assert.ok(existsSync(join(artifacts, 'analysis')), 'the remote observation is retained beside the queued job');
});

test('a red remote step returns its refusal to the queued submit, and altered output or cut authority refuses [V4,C7]', async t => {
  const red = fixture(t, { red: true });
  await assert.rejects(remoteSubmitAnalysis(red.controller, request(red), fakeRunner(red), join(red.dir, 'artifacts')),
    error => error.code === 'GATE_RED' && /one import binding per line/u.test(error.message));
  const box = fixture(t);
  await assert.rejects(remoteSubmitAnalysis(box.controller, request(box), fakeRunner(box, { tamper: true }), join(box.dir, 'tampered')),
    { code: 'RUNNER_RESULT_INVALID' });
  let reads = 0;
  await assert.rejects(remoteSubmitAnalysis(box.controller, request(box, () => [{ item_id: ++reads > 2 ? 8 : 7 }]), fakeRunner(box), join(box.dir, 'moved')),
    { code: 'CELLS_SUBMIT' });
  await assert.rejects(remoteSubmitAnalysis(box.controller, request(box), { runner: null }, join(box.dir, 'none')), { code: 'RUNNER_SOURCE' });
});

test('a trunk Git read failure on the runner repeats the analysis and never refuses the builder [C7]', async t => {
  const flaky = fixture(t, { flaky: 1 });
  const { value } = await controllerSpawns(() => remoteSubmitAnalysis(flaky.controller, request(flaky), fakeRunner(flaky), join(flaky.dir, 'artifacts')));
  assert.deepEqual(value.cells.cells, ['trusted-main'], 'the second attempt passes placement');
  assert.equal(readFileSync(join(flaky.runner, '.git', 'placement-reads'), 'utf8'), '2');
  const down = fixture(t, { flaky: 99 });
  await assert.rejects(remoteSubmitAnalysis(down.controller, request(down), fakeRunner(down), join(down.dir, 'artifacts')),
    error => error.name !== 'Refused' && error.code === 'GIT_READ_INFRASTRUCTURE' && error.retryable === true);
});

test('queued submits go remote when a runner is registered or runners-only is set [V4,C7]', () => {
  assert.equal(remoteGateWanted({}, { runners: [] }), false);
  assert.equal(remoteGateWanted({ runnerOnly: true }, { runners: [] }), true);
  assert.equal(remoteGateWanted({}, { runners: [{ host: 'runner-1', slots: 9 }] }), true);
});

test('independent trusted analysis parts run only their named work [C7]', async t => {
  const box = fixture(t), artifacts = join(box.dir, 'parts');
  const select = async part => remoteSubmitAnalysis(box.controller, { ...request(box), parts: [part] }, fakeRunner(box), artifacts);
  const preflight = await select('preflight');
  assert.deepEqual(Object.keys(preflight.steps), ['placement', 'composition']);
  const cells = await select('cells');
  assert.deepEqual(Object.keys(cells.steps), ['cells']);
  assert.deepEqual(cells.cells.cells, ['trusted-main']);
  const selection = await select('selection');
  assert.deepEqual(Object.keys(selection.steps), ['selection', 'admission']);
  assert.deepEqual(selection.plan.proofFiles, ['test/a.test.js']);
  const statics = await select('static');
  assert.deepEqual(Object.keys(statics.steps), ['static']);
});

test('clause 1: analysis loads main\'s own tooling, never an installed copy that imports a name main dropped; clause 2: the receipt names main [C7]', async t => {
  const box = fixture(t);
  // An installed Pullboard copy on the runner whose module imports a name pinned main no longer exports.
  const installed = join(box.runner, 'node_modules', 'pullboard', 'bin');
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, 'cells-submit-checks.js'), "import { transferredCellsInventories } from './cells-inventory-cache.js';\nexport const requireSubmitCells = transferredCellsInventories;\n");
  writeFileSync(join(installed, 'cells-inventory-cache.js'), 'export const inventoryCache = 1;\n');
  const artifacts = join(box.dir, 'artifacts');
  const { value } = await controllerSpawns(() => remoteSubmitAnalysis(box.controller, request(box), fakeRunner(box), artifacts));
  assert.deepEqual(value.cells.cells, ['trusted-main']);
  const [directory] = readdirSync(join(artifacts, 'analysis'));
  const observation = JSON.parse(readFileSync(join(artifacts, 'analysis', directory, 'observation.json'), 'utf8'));
  assert.deepEqual(observation.toolingSource, { kind: 'pinned-main', commit: box.main });
});

test('clause 3: a real import failure in pinned main\'s own tooling still refuses RUNNER_RESULT_INVALID [C7]', async t => {
  const box = fixture(t, { brokenMain: true });
  await assert.rejects(remoteSubmitAnalysis(box.controller, request(box), fakeRunner(box), join(box.dir, 'artifacts')), { code: 'RUNNER_RESULT_INVALID' });
});

test('clause 1: a cold accepted inventory is produced on the runner with main as its trunk, and the controller runs only git [C7]', async t => {
  const box = fixture(t, { cellsPlan: true });
  const { value, seen } = await controllerSpawns(() => remoteSubmitAnalysis(box.controller, request(box), fakeRunner(box), join(box.dir, 'artifacts')));
  // The runner's cell analysis read the inventory it produced itself, bound to the controller's pinned main.
  assert.deepEqual(value.cells.cells, ['trusted-main', `inventory trunk ${box.main}`]);
  assert.deepEqual(Object.keys(value.steps), ['placement', 'static', 'composition', 'inventory', 'cells', 'selection', 'admission']);
  assert.ok(value.notes.includes(`submit cells inventory: produced on the runner for ${box.main.slice(0, 12)}`));
  const steps = readFileSync(join(box.runner, '.git', 'trusted-steps.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const inventory = steps.find(row => row.step === 'inventory');
  assert.equal(realpathSync(inventory.root), realpathSync(box.runner));
  assert.match(inventory.url, /pullboard-trusted-main-/u);
  assert.notEqual(inventory.pid, process.pid);
  // Nothing was produced in the controller's checkout, and the controller started no process but git.
  assert.equal(existsSync(join(box.controller, '.git', 'trusted-steps.jsonl')), false);
  assert.equal(existsSync(join(box.controller, '.git', `produced-${box.main}`)), false);
  assert.deepEqual(seen.filter(command => basename(command.split(' ')[0]) !== 'git'), []);
});

test('clause 2: a runner that cannot produce the accepted inventory stops as pending infrastructure, never the builder\'s red, and the coordinator build stays the fallback [C7]', async t => {
  const box = fixture(t, { cellsPlan: true, warmFails: true });
  await assert.rejects(remoteSubmitAnalysis(box.controller, request(box), fakeRunner(box), join(box.dir, 'artifacts')),
    error => error.name === 'CellsInventoryInfrastructureError' && error.code === 'CELLS_INVENTORY_PENDING' && error.retryable === true
      && error.commit === box.main && /fixture producer failed/u.test(error.message));
  // The queued gate's settle loop hands that stop to the coordinator's inventory build for main, then reruns the same
  // candidate: no attempt is spent and nothing goes red for the builder.
  const built = [];
  let runs = 0;
  const settled = await submitUntilSettled(async () => {
    runs += 1;
    if (runs === 1) return remoteSubmitAnalysis(box.controller, request(box), fakeRunner(box), join(box.dir, 'artifacts'));
    return 'same candidate after the coordinator build';
  }, { waitInventory: async commit => { built.push(commit); return { waited: 1 }; }, healthy: async () => true, wait: async () => {} });
  assert.deepEqual(built, [box.main]);
  assert.equal(runs, 2);
  assert.equal(settled.result, 'same candidate after the coordinator build');
  assert.deepEqual(settled.attempts, []);
});

/** The scopes the fixture's static command was handed, one per run: a list of paths, or null for a whole-tree run. */
function staticScopes(box) {
  const file = join(box.runner, '.git', 'static-scope.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
}

test('clause 1 [5814]: the static step is handed only the paths the item changed against main when no whole-repo input changed [C7]', async t => {
  const box = fixture(t, { scoped: true });
  const value = await remoteSubmitAnalysis(box.controller, request(box), fakeRunner(box), join(box.dir, 'artifacts'));
  const changed = execFileSync('git', ['diff', '--name-only', box.main, box.source], { cwd: box.controller, env: box.env, encoding: 'utf8' }).trim().split('\n').sort();
  assert.deepEqual(staticScopes(box), [changed]);
  assert.ok(changed.includes('src/thing.js'));
  assert.ok(value.steps.static >= 0, 'the static step ran');
  // A change to an input every rule reads runs the whole tree, and says why.
  const whole = fixture(t, { scoped: true, wholeRepo: true });
  const wide = await remoteSubmitAnalysis(whole.controller, request(whole), fakeRunner(whole), join(whole.dir, 'artifacts'));
  assert.deepEqual(staticScopes(whole), [null]);
  assert.ok(wide.notes.some(note => note.startsWith('analysis: whole tree, since package.json')));
});

test('clause 2 [5814]: resubmitting the same head reuses the recorded static result, and a red result is never kept [C7]', async t => {
  const box = fixture(t, { scoped: true });
  await remoteSubmitAnalysis(box.controller, request(box), fakeRunner(box), join(box.dir, 'first'));
  const again = await remoteSubmitAnalysis(box.controller, request(box), fakeRunner(box), join(box.dir, 'second'));
  assert.equal(staticScopes(box).length, 1, 'the static command ran once for the head');
  assert.equal(again.steps.static, undefined);
  assert.ok(again.notes.includes('static checks: reused the green run kept for this head'));
  const red = fixture(t, { scoped: true, red: true });
  for (const attempt of ['first', 'second']) {
    await assert.rejects(remoteSubmitAnalysis(red.controller, request(red), fakeRunner(red), join(red.dir, attempt)), { code: 'GATE_RED' });
  }
  assert.equal(staticScopes(red).length, 2, 'a red head runs its static check again');
});
