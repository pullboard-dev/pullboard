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
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { remoteSubmitAnalysis } from '../src/submit-remote-gate.js';
import { remoteGateWanted } from '../src/submit-remote-gate.js';

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
function fixture(t, { red = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'submit-remote-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = gitEnv();
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
export function requirePlannedSource(root) { record(root, 'placement', import.meta.url); }
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
`);
  put('packages/landing/index.js', 'export function withMainCheckout() {}\n');
  put('bin/cells-submit-checks.js', `import { record } from './record.js';
export async function requireSubmitCells(root, main, source, item, services) {
  record(root, 'cells', import.meta.url);
  if (JSON.parse(item.item_frozen).criterion !== 'fixture criterion' || services.readCutItems()[0].item_id !== 7) throw new Error('lost authority');
  return { acceptedMain: main, source, cells: ['trusted-main'], existingCuts: [] };
}
`);
  put('bin/static-style-checks.js', `import { existsSync } from 'node:fs';
import { record } from './record.js';
record(process.cwd(), 'static', import.meta.url);
if (existsSync('RED')) { console.error('src/thing.js:1 one import binding per line'); process.exitCode = 1; }
`);
  git(controller, 'add', '.');
  git(controller, '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'trusted main');
  const main = git(controller, 'rev-parse', 'HEAD');
  const bomb = "throw new Error('candidate tooling was executed');\n";
  for (const path of ['bin/record.js', 'bin/cells-submit-checks.js', 'bin/static-style-checks.js', 'packages/items/index.js', 'packages/gate/index.js', 'packages/landing/index.js']) put(path, bomb);
  put('src/thing.js', 'export const thing = 1;\n');
  if (red) put('RED', 'candidate data\n');
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
    composition: box.source, staticChecks: 'node bin/static-style-checks.js', config: { affectedTests: 'node bin/run-tests.js', gate: 'npm test' },
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
    assert.equal(row.root, box.runner);
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
  await assert.rejects(remoteSubmitAnalysis(box.controller, request(box, () => [{ item_id: ++reads > 1 ? 8 : 7 }]), fakeRunner(box), join(box.dir, 'moved')),
    { code: 'CELLS_SUBMIT' });
  await assert.rejects(remoteSubmitAnalysis(box.controller, request(box), { runner: null }, join(box.dir, 'none')), { code: 'RUNNER_SOURCE' });
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
