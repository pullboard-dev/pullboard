/** @pullboard-test-input source-cell apps/cli */
/** With gate.knownMainStatic on, the trusted analysis entry passes a static red main also has and returns its rows as staticKnownMain [C7,#10567]. */
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
import { fixtureMachineSettings } from '../../../../../../packages/gate/tests/fixtures/testkit.js';

/** A Git environment free of the caller's repository selectors and identity. */
function gitEnv() {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !/^GIT_(CONFIG_GLOBAL|CONFIG_NOSYSTEM|AUTHOR_|COMMITTER_)/u.test(key)) delete env[key];
  return env;
}

/** Each fixture tool appends its name to the runner checkout's marks file. */
const MARK = "import { appendFileSync } from 'node:fs';\nimport { join } from 'node:path';\nexport function mark(root, name) { appendFileSync(join(root, '.git', 'marks.jsonl'), JSON.stringify({ name }) + '\\n'); }\n";

/** Static checks that print one row per marker file the candidate holds, and go red when it holds any. */
const STATIC = `import { existsSync } from 'node:fs';
const rows = [['MAIN_RED', 'src/main.js rule-main'], ['ITEM_RED', 'src/item.js rule-item']].filter(([file]) => existsSync(file));
for (const [, row] of rows) console.error(row);
if (rows.length) process.exitCode = 1;
`;

/** The gate door of the fixture's main: main's findings are one fixed row, and the split follows the real shape. */
const GATE = `import { mark } from '../../bin/mark.js';
export function importsIn() {} export function commonJsIn() {} export function withImportParseCache() {}
export function foreignNodeOptions() { return false; }
export function submitGatePlan(root, config, options) { return { proofFiles: ['test/a.test.js'], check: options.check }; }
export async function submitGateAdmission() { return { browser: false, gui: false }; }
export async function staticFindingsOnMain(root) { mark(root, 'main-read'); return [{ rule: 'rule-main', file: 'src/main.js' }]; }
export function splitByMain(output, main) {
  const item = String(output).split('\\n').filter(Boolean).map(row => { const [file, rule] = row.split(' '); return { file, rule, row }; });
  const held = finding => main.some(row => row.file === finding.file && row.rule === finding.rule);
  return { item, known: item.filter(held).map(({ rule, file }) => ({ rule, file })), rows: item.filter(finding => !held(finding)).map(finding => finding.row) };
}
`;

/** A controller whose main holds the fixture tooling, and a runner clone checked out at a candidate holding the marker files in \`red\`. */
function fixture(t, red) {
  const dir = temporaryDirectory('submit-known-main-static-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = gitEnv(), controller = temporaryRepository(t, 'submit-known-main-static-controller-'), runner = join(dir, 'runner');
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env });
  const put = (path, body) => { const file = join(controller, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, body); };
  git(controller, 'config', 'pullboard.trunk', 'refs/heads/main');
  put('package.json', '{"type":"module"}\n');
  put('bin/mark.js', MARK);
  put('packages/items/index.js', 'export function requireSubmitComposition() {}\n');
  put('packages/gate/index.js', GATE);
  put('packages/landing/index.js', 'export function withMainCheckout() {}\n');
  put('bin/cells-submit-checks.js', 'export async function requireSubmitCells(root, main, source) { return { acceptedMain: main, source, cells: [], existingCuts: [] }; }\n');
  put('apps/cli/src/io/cells/cache.js', 'export function transferredCellsInventories() { return null; }\n');
  put('bin/static-checks.js', STATIC);
  git(controller, 'add', '.');
  git(controller, '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'main');
  const main = git(controller, 'rev-parse', 'HEAD');
  for (const file of red) put(file, 'candidate data\n');
  put('src/thing.js', 'export const thing = 1;\n');
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

/** The analysis request a queued submit sends, in per-part mode so a static red is recorded as its own outcome. */
function request(box) {
  return { main: box.main, source: box.source, trunk: box.main, base: box.main, check: 'node --test test/a.test.js', criterion: 'c',
    staticChecks: 'node bin/static-checks.js', config: { affectedTests: 'node apps/cli/src/io/run/tests.js' }, browserFreeChecks: true,
    readCutItems: () => [], perPart: true };
}

/** Run the analysis under a machine home whose gate.knownMainStatic is `on`. */
async function analyse(t, box, on) {
  const home = join(box.dir, 'machine');
  mkdirSync(home, { recursive: true });
  fixtureMachineSettings(home, { gate: { knownMainStatic: on } });
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
  return remoteSubmitAnalysis(box.controller, request(box), runnerLease(box), join(box.dir, 'artifacts'));
}

/** The names the fixture tools marked in the runner checkout. */
function marks(box) {
  const file = join(box.runner, '.git', 'marks.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line).name) : [];
}

test('cli.io-submit-gate-known-main-static.red-only-in-main-rows-is-passed: clause 1: with knownMainStatic on, a static red only in rows main also has is not refused and its rows come back as staticKnownMain [C7,#10567]', async t => {
  const box = fixture(t, ['MAIN_RED']);
  const value = await analyse(t, box, true);
  assert.deepEqual(value.outcomes, {}, 'the static part is not refused');
  assert.deepEqual(value.staticKnownMain, [{ rule: 'rule-main', file: 'src/main.js' }]);
  assert.deepEqual(marks(box), ['main-read']);
});

test('cli.io-submit-gate-known-main-static.item-only-row-still-refuses: clause 2: a row red only on the item still refuses GATE_RED naming that row, and with knownMainStatic unset main is never read [C7,#10567]', async t => {
  const mixed = fixture(t, ['MAIN_RED', 'ITEM_RED']);
  const value = await analyse(t, mixed, true);
  assert.equal(value.outcomes.static.refused.code, 'GATE_RED');
  assert.match(value.outcomes.static.refused.message, /src\/item\.js rule-item/u);
  assert.doesNotMatch(value.outcomes.static.refused.message, /src\/main\.js/u, 'the refusal names only the item row');
  assert.equal(value.staticKnownMain, undefined);
  const off = fixture(t, ['MAIN_RED']);
  const refused = await analyse(t, off, false);
  assert.equal(refused.outcomes.static.refused.code, 'GATE_RED');
  assert.deepEqual(marks(off), [], 'main was never read');
});

test('cli.io-submit-gate-known-main-static.input-flag-follows-the-machine-setting: clause 3: the analysis input carries knownMainStatic true only when the machine setting gate.knownMainStatic is on [C7,#10567]', async t => {
  const on = await analyse(t, fixture(t, ['MAIN_RED']), true);
  assert.equal(on.outcomes.static, undefined, 'setting on: the input flag reached the entry');
  const box = fixture(t, ['MAIN_RED']);
  const off = await analyse(t, box, false);
  assert.equal(off.outcomes.static.refused.code, 'GATE_RED', 'setting off: the input flag is absent');
  assert.equal(off.staticKnownMain, undefined);
});
