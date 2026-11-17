/** The runner analysis runs its static checks beside cells and selection, and a static red still refuses as its part [C7]. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { remoteSubmitAnalysis } from '../../../../src/io/submit/gate.js';
import { temporaryDirectory } from '../../../fixtures/board.js';
import { temporaryRepository } from '../../../fixtures/board/submit.js';
import { runFixtureGit } from '../../../fixtures/child.js';

/** A Git environment free of the caller's repository selectors and identity. */
function gitEnv() {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !/^GIT_(CONFIG_GLOBAL|CONFIG_NOSYSTEM|AUTHOR_|COMMITTER_)/u.test(key)) delete env[key];
  return env;
}

/** Each fixture tool appends when it ran to the runner checkout's marks file. */
const MARK = "import { appendFileSync } from 'node:fs';\nimport { join } from 'node:path';\nexport function mark(root, name) { appendFileSync(join(root, '.git', 'marks.jsonl'), JSON.stringify({ name, at: Date.now() }) + '\\n'); }\n";

/** Static checks that take 1.5 s and go red when the candidate holds RED. */
const STATIC = `import { existsSync } from 'node:fs';
import { mark } from './mark.js';
mark(process.cwd(), 'static-start');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
mark(process.cwd(), 'static-end');
if (existsSync('RED')) { console.error('src/thing.js:1 one import binding per line'); process.exitCode = 1; }
`;

/** A controller whose main holds marking tooling, and a runner clone checked out at the candidate. */
function fixture(t, { red = false } = {}) {
  const dir = temporaryDirectory('submit-static-overlap-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = gitEnv(), controller = temporaryRepository(t, 'submit-static-overlap-controller-'), runner = join(dir, 'runner');
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env });
  const put = (path, body) => { const file = join(controller, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, body); };
  git(controller, 'config', 'pullboard.trunk', 'refs/heads/main');
  put('package.json', '{"type":"module"}\n');
  put('bin/mark.js', MARK);
  put('packages/items/index.js', 'export function requireSubmitComposition() {}\n');
  put('packages/gate/index.js', `import { mark } from '../../bin/mark.js';
export function importsIn() {} export function commonJsIn() {} export function withImportParseCache() {}
export function foreignNodeOptions() { return false; }
export function submitGatePlan(root, config, options) { mark(root, 'selection'); return { proofFiles: ['test/a.test.js'], check: options.check }; }
export async function submitGateAdmission() { return { browser: false, gui: false }; }
`);
  put('packages/landing/index.js', 'export function withMainCheckout() {}\n');
  put('bin/cells-submit-checks.js', `import { mark } from './mark.js';
export async function requireSubmitCells(root, main, source) { mark(root, 'cells'); return { acceptedMain: main, source, cells: [], existingCuts: [] }; }\n`);
  put('apps/cli/src/io/cells/cache.js', 'export function transferredCellsInventories() { return null; }\n');
  put('bin/static-checks.js', STATIC);
  git(controller, 'add', '.');
  git(controller, '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'main');
  const main = git(controller, 'rev-parse', 'HEAD');
  put('src/thing.js', 'export const thing = 1;\n');
  if (red) put('RED', 'candidate data\n');
  git(controller, 'add', '.');
  git(controller, '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'candidate');
  const source = git(controller, 'rev-parse', 'HEAD');
  git(dir, 'clone', '--quiet', '--no-checkout', controller, runner);
  git(runner, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', source);
  return { controller, runner, main, source, env, tree: git(controller, 'rev-parse', `${source}^{tree}`), dir };
}

/** A runner transport that runs the private check in the runner clone and returns its authenticated receipt. */
function runnerLease(box) {
  const runOnRunnerAsync = async (_root, shell, options) => {
    let bytes;
    try { bytes = execFileSync('/bin/sh', ['-c', shell], { cwd: box.runner, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { bytes = Buffer.concat([error.stdout ?? Buffer.alloc(0), error.stderr ?? Buffer.alloc(0)]); }
    writeFileSync(options.rawOutputPath, bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return { executionRunner: 'runner-1', executionSource: { commit: box.source, tree: box.tree }, rawOutputPath: options.rawOutputPath,
      privateCheck: { receipt: { requestSha256: options.privateCheck.sha256, sourceUnchanged: true,
        phases: { check: { offset: 0, length: bytes.length, code: 0, signal: null, timedOut: false, sha256 } } } } };
  };
  return { runner: { host: 'runner-1', node: process.execPath }, source: { commit: box.source, tree: box.tree }, executionServices: { runners: { runOnRunnerAsync } } };
}

/** The analysis request a queued submit sends, with or without per-part outcomes. */
function request(box, perPart) {
  return { main: box.main, source: box.source, trunk: box.main, base: box.main, check: 'node --test test/a.test.js', criterion: 'c',
    staticChecks: 'node bin/static-checks.js', config: { affectedTests: 'node apps/cli/src/io/run/tests.js' }, browserFreeChecks: true,
    readCutItems: () => [], ...(perPart ? { perPart: true } : {}) };
}

/** When each fixture tool ran in the runner checkout, by name. */
function marks(box) {
  const file = join(box.runner, '.git', 'marks.jsonl');
  return existsSync(file) ? Object.fromEntries(readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)).map(row => [row.name, row.at])) : {};
}

test('clause 1: per part, cells and selection run while the static checks run [C7]', async t => {
  const box = fixture(t);
  const value = await remoteSubmitAnalysis(box.controller, request(box, true), runnerLease(box), join(box.dir, 'artifacts'));
  const at = marks(box);
  assert.ok(at.cells < at['static-end'], 'cells ran before the static checks ended');
  assert.ok(at.selection < at['static-end'], 'selection ran before the static checks ended');
  assert.ok(value.steps.static >= 1400, 'the static step still measures its own run');
  assert.deepEqual(value.outcomes, {});
  assert.deepEqual(value.plan.proofFiles, ['test/a.test.js']);
});

test('clause 1: per part, a static red is its own refusal with the output tail while cells and selection stay green [C7]', async t => {
  const box = fixture(t, { red: true });
  const value = await remoteSubmitAnalysis(box.controller, request(box, true), runnerLease(box), join(box.dir, 'artifacts'));
  assert.equal(value.outcomes.static.refused.code, 'GATE_RED');
  assert.match(value.outcomes.static.refused.message, /static checks are red.*one import binding per line/su);
  assert.deepEqual(value.cells.cells, []);
  assert.deepEqual(value.plan.proofFiles, ['test/a.test.js']);
});

test('clause 2: without per-part outcomes a static red ends the analysis before cells runs [C7]', async t => {
  const box = fixture(t, { red: true });
  await assert.rejects(remoteSubmitAnalysis(box.controller, request(box, false), runnerLease(box), join(box.dir, 'artifacts')),
    error => error.code === 'GATE_RED' && /one import binding per line/u.test(error.message));
  const at = marks(box);
  assert.ok(at['static-end'], 'the static checks ran');
  assert.equal(at.cells, undefined, 'cells never ran after the red');
});
