/** A controller, a runner clone and an injected runner transport for the queued submit's authorization stage [C7,#5674,#5761]. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { remoteSubmitAnalysis } from '../../../src/io/submit/gate.js';
import { sharedRemoteAnalysis } from '../../../src/io/submit/gate.js';
import { temporaryDirectory } from '../board.js';
import { temporaryRepository } from '../board/submit.js';
import { runFixtureGit } from '../child.js';

export const PARTS = ['authorization', 'doctrine', 'selection'];

/** A Git environment free of the caller's repository selectors and identity. */
function gitEnv() {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !/^GIT_(CONFIG_GLOBAL|CONFIG_NOSYSTEM|AUTHOR_|COMMITTER_)/u.test(key)) delete env[key];
  return env;
}

/**
 * A controller whose accepted main carries stand-in tooling, and a runner clone at the candidate. Each stand-in writes
 * a marker into the runner checkout's .git, so the test sees which process ran each stage. `sandbox` is the main's
 * sandbox module: 'owned', 'foreign' (an OUTSIDE_LANE refusal) or 'absent' (a main that predates the export).
 */
export function fixture(t, { sandbox = 'owned' } = {}) {
  const dir = temporaryDirectory('submit-authorization-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = gitEnv(), controller = temporaryRepository(t, 'submit-authorization-controller-'), runner = join(dir, 'runner');
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env });
  const put = (path, body) => { const file = join(controller, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, body); };
  const mark = name => `(await import('node:fs')).writeFileSync(root + '/.git/ran-' + ${JSON.stringify(name)}, String(process.pid));`;
  git(controller, 'config', 'pullboard.trunk', 'refs/heads/main');
  put('package.json', '{"type":"module"}\n');
  put('packages/items/index.js', 'export function requireSubmitComposition() {}\n');
  put('packages/gate/heavy.js', "export * from './index.js';\n");
  put('packages/gate/index.js', `export function importsIn() {} export function commonJsIn() {} export function withImportParseCache() {}
export function foreignNodeOptions() { return false; }
export async function submitGatePlan(root, config, options) { ${mark('selection')} return { proofFiles: ['test/a.test.js'], check: options.check }; }
export async function submitGateAdmission() { return { browser: false, gui: false }; }
`);
  put('packages/landing/index.js', 'export function withMainCheckout() {}\n');
  put('bin/cells-submit-checks.js', 'export async function requireSubmitCells(root, main, source) { return { acceptedMain: main, source, cells: [], existingCuts: [] }; }\n');
  put('apps/cli/src/io/cells/cache.js', 'export function transferredCellsInventories() { return null; }\n');
  put('packages/doctrine/index.js', `export async function holdDoctrineAsync(root, options) { ${mark('doctrine')} return [{ rule: 'fixture', commit: options.commit }]; }\n`);
  const outcome = sandbox === 'foreign'
    ? "throw Object.assign(new Error('[OUTSIDE_LANE] outside the web lane: docs/x.md'), { name: 'Refused', code: 'OUTSIDE_LANE', paths: ['docs/x.md'], policy: 'p' });"
    : "onMechanicalPaths(['packages/moved.js']); return ['src/thing.js'];";
  if (sandbox !== 'absent') put('packages/sandbox/index.js', `import { writeFileSync } from 'node:fs';
export function submissionPaths(root, item, commit, { onMechanicalPaths, dependencies }) {
  writeFileSync(root + '/.git/ran-authorization', JSON.stringify({ pid: process.pid, item: item.item_id, lane: item.item_lane, commit, dependencies }));
  ${outcome}
}
`);
  git(controller, 'add', '.');
  git(controller, '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'main');
  const main = git(controller, 'rev-parse', 'HEAD');
  put('src/thing.js', 'export const thing = 1;\n');
  git(controller, 'add', '.');
  git(controller, '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'candidate');
  const source = git(controller, 'rev-parse', 'HEAD');
  git(dir, 'clone', '--quiet', '--no-checkout', controller, runner);
  git(runner, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', source);
  return { controller, runner, main, source, env, tree: git(controller, 'rev-parse', `${source}^{tree}`), dir };
}

/** An injected runner transport that runs each request in the runner clone and counts the runner jobs it starts. */
export function countingRunner(box) {
  const counts = { jobs: 0 };
  const runOnRunnerAsync = async (_root, shell, options) => {
    counts.jobs++;
    let bytes;
    try { bytes = execFileSync('/bin/sh', ['-c', shell], { cwd: box.runner, env: box.env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { bytes = Buffer.concat([error.stdout ?? Buffer.alloc(0), error.stderr ?? Buffer.alloc(0)]); }
    writeFileSync(options.rawOutputPath, bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return { executionRunner: 'runner-1', executionSource: { commit: box.source, tree: box.tree }, rawOutputPath: options.rawOutputPath,
      privateCheck: { receipt: { requestSha256: options.privateCheck.sha256, sourceUnchanged: true,
        phases: { check: { offset: 0, length: bytes.length, code: 0, signal: null, timedOut: false, sha256 } } } } };
  };
  return { counts, lease: { runner: { host: 'runner-1', node: process.execPath }, source: { commit: box.source, tree: box.tree }, executionServices: { runners: { runOnRunnerAsync } } } };
}

/** The submit gate's request: authorization, doctrine and selection read from one shared job, as submit.js asks for them. */
export async function submitStages(box, runner, extra = {}) {
  const item = { item_id: 5674, item_lane: 'core', item_claim_head: box.main, item_frozen: null };
  const request = { main: box.main, source: box.source, trunk: box.main, base: box.main, check: 'node --test test/a.test.js', criterion: 'c',
    composition: null, staticChecks: '', config: { affectedTests: 'node apps/cli/src/io/run/tests.js' }, browserFreeChecks: true, readCutItems: () => [], perPart: true,
    doctrine: { mainCommit: box.main, commit: box.source, practice: {}, timeoutMs: 1000 }, authorization: { item, ...extra } };
  const read = sharedRemoteAnalysis(() => remoteSubmitAnalysis(box.controller, request, runner.lease, join(box.dir, 'artifacts')));
  return Promise.allSettled(PARTS.map(part => read(part, new AbortController().signal)));
}

/** The marker a runner-side stage left in the runner checkout, or null when that stage never ran there. */
export function ran(box, name) {
  try { return readFileSync(join(box.runner, '.git', `ran-${name}`), 'utf8'); } catch { return null; }
}

