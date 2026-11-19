/** @pullboard-test-input source-cell packages/landing packages/state */
/** A named landing's engine numbers are built by a runner job and applied by the coordinator as a patch [C7,#5568]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  privateFixtureFiles,
  runFixtureGit,
} from '../../gate/tests/fixtures/child.js';
import { commitDerived } from '../src/io/step/derive.js';
import { composeOnRunner } from '../src/io/step/compose.js';
import { stageLandingDerived } from '../src/io/derive.js';

const DERIVE = fileURLToPath(new URL('../src/io/derive.js', import.meta.url));
const COMPOSE = fileURLToPath(new URL('../src/io/compose.js', import.meta.url));
const LEAF = 'packages/state/src/logic/engines/feature-engine.js';

/** A real repo with one numbered engine and one unnumbered leaf committed on top; resolves its root and a git runner. */
function repo(t) {
  const { root } = privateFixtureFiles('landing-derive-');
  const sh = (...args) => runFixtureGit(args, { cwd: root });
  const put = (file, text) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); };
  sh('init', '-q', '-b', 'main');
  sh('config', 'user.email', 't@example.com');
  sh('config', 'user.name', 't');
  put('package.json', '{"type":"module"}\n');
  put('packages/state/src/logic/engines/base-engine.js', 'export const BASE_ENGINE = 80;\n');
  put('packages/state/src/logic/engines/unassigned.js', 'export const unassignedEngine = () => 81;\n');
  sh('add', '-A');
  sh('commit', '-q', '-m', 'base');
  put(LEAF, "import { unassignedEngine } from './engine-next.js';\nexport const FEATURE_ENGINE = unassignedEngine();\n");
  sh('add', '-A');
  sh('commit', '-q', '-m', 'item');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, sh };
}

/** Stand in for the runner: run the derive script in a second checkout of the same tree and hand back its output. */
function runnerOutput(root, sh) {
  const { root: twin } = privateFixtureFiles('landing-derive-runner-');
  runFixtureGit(['clone', '-q', root, twin], { cwd: root });
  const ran = spawnSync(process.execPath, [DERIVE, '--tree', sh('rev-parse', 'HEAD^{tree}')], { cwd: twin, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  rmSync(twin, { recursive: true, force: true });
  assert.equal(ran.status, 0, ran.stderr);
  return ran.stdout;
}

test('landing.derive.commitderived-applies-a-runner-patch-that: commitDerived applies a runner patch that numbers the engine, without deriving on the coordinator [C7,#5568]', async t => {
  const { root, sh } = repo(t);
  const output = runnerOutput(root, sh);
  const said = [];
  const state = { batch: { root }, config: {}, say: line => said.push(line), guardServices: { runStaticChecks: async () => ({ output }) } };
  const merged = [{ id: 1, merge: sh('rev-parse', 'HEAD') }];
  const files = await commitDerived(state, merged, []);
  assert.match(readFileSync(join(root, LEAF), 'utf8'), /FEATURE_ENGINE = 81;/u);
  assert.ok(files.includes(LEAF), files.join(','));
  assert.deepEqual(said, ['engine FEATURE_ENGINE: 81']);
  assert.equal(merged[0].merge, sh('rev-parse', 'HEAD'), 'the item merge entry follows the amended commit');
});

test('landing.derive.commitderived-derives-on-the-coordinator-when: commitDerived derives on the coordinator when the runner could not answer [C7,#5568]', async t => {
  const { root, sh } = repo(t);
  const said = [];
  const state = { batch: { root }, config: {}, say: line => said.push(line), guardServices: { runStaticChecks: async () => ({ output: 'LANDING_DERIVE_UNAVAILABLE\n' }) } };
  await commitDerived(state, [{ id: 1, merge: sh('rev-parse', 'HEAD') }], []);
  assert.match(readFileSync(join(root, LEAF), 'utf8'), /FEATURE_ENGINE = 81;/u);
  assert.match(said.join('\n'), /could not derive this batch/u);
});

test('landing.derive.the-derive-job-writes-the-badge: the derive job writes the badge documents it is handed and counts held doctrine rules on the derived tree [C7,#5583]', async t => {
  const { root, sh } = repo(t);
  const { root: twin } = privateFixtureFiles('landing-derive-badges-');
  runFixtureGit(['clone', '-q', root, twin], { cwd: root });
  const docs = [{ path: 'docs/badges/items.json', text: '{"items":1}\n' }];
  const ran = spawnSync(process.execPath, [DERIVE, '--tree', sh('rev-parse', 'HEAD^{tree}'), '--badges', Buffer.from(JSON.stringify(docs)).toString('base64'), '--doctrine'], { cwd: twin, encoding: 'utf8' });
  rmSync(twin, { recursive: true, force: true });
  assert.equal(ran.status, 0, ran.stderr);
  const patch = Buffer.from(ran.stdout.split('\n').find(line => line.startsWith('LANDING_DERIVE_PATCH=')).slice(21), 'base64').toString('utf8');
  assert.match(patch, /docs\/badges\/items\.json/u);
  assert.match(patch, /FEATURE_ENGINE = 81/u);
  // This repo has no doctrine file, so there are no held rules to count and no rules line is printed.
  assert.doesNotMatch(ran.stdout, /LANDING_DERIVE_RULES=\[\{/u);
});

test('landing.derive.commitderived-hands-the-runner-counted-doctrine: commitDerived hands the runner-counted doctrine rows to the landing and writes badges only in the job [C7,#5583]', async t => {
  const { root, sh } = repo(t);
  const output = `${runnerOutput(root, sh)}LANDING_DERIVE_RULES=[{"id":"D1","count":3,"found":2,"broken":null}]\n`;
  const state = { batch: { root }, config: {}, say() {}, guardServices: { runStaticChecks: async () => ({ output }) },
    board: {}, landingPorts: { badgeCounts: () => ({ items: 0 }), badgeDocuments: () => [], writeBadges: () => [] } };
  await commitDerived(state, [{ id: 1, merge: sh('rev-parse', 'HEAD') }], []);
  assert.deepEqual(state.measuredRules, [{ id: 'D1', count: 3, found: 2, broken: null }]);
});

/** A base with a numbered engine and two item commits off it (the second adds an unnumbered engine), as a coordinator checkout at the base. */
function composeRepo(t) {
  const { root, sh } = repo(t);
  const leaf = sh('rev-parse', 'HEAD');
  sh('checkout', '-q', '-b', 'item-a', 'HEAD~1');
  mkdirSync(join(root, 'web'), { recursive: true });
  writeFileSync(join(root, 'web/a.txt'), 'a\n');
  sh('add', '-A');
  sh('commit', '-q', '-m', 'feat(web): a');
  const a = sh('rev-parse', 'HEAD');
  sh('checkout', '-q', 'main');
  sh('checkout', '-q', '-b', 'base', 'HEAD~1');
  const base = sh('rev-parse', 'HEAD');
  sh('checkout', '-q', '--detach', base);
  return { root, sh, base, plan: [{ id: 1, commit: a, header: 'Merge #1 onto main', trailers: 'Pullboard-Item: #1' }, { id: 2, commit: leaf, header: 'Merge #2 onto main', trailers: 'Pullboard-Item: #2' }] };
}

/** Stand in for the runner: run the compose script in a clone sharing the coordinator's objects and hand back its output. */
function composeOutput(root, state, plan) {
  const { root: twin } = privateFixtureFiles('landing-compose-runner-');
  runFixtureGit(['clone', '-q', '--no-checkout', root, twin], { cwd: root });
  runFixtureGit(['checkout', '-q', '--detach', state.batch.base], { cwd: twin });
  for (const entry of plan) runFixtureGit(['fetch', '-q', root, entry.commit], { cwd: twin });
  const command = state.command;
  const ran = spawnSync(process.execPath, [COMPOSE, ...command], { cwd: twin, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  rmSync(twin, { recursive: true, force: true });
  assert.equal(ran.status, 0, ran.stderr);
  return ran.stdout;
}

test('landing.derive.composeonrunner-brings-the-runner-built-landing: composeOnRunner brings the runner-built landing commit here as objects and moves the checkout to it [C7,#5585]', async t => {
  const { root, sh, base, plan } = composeRepo(t);
  const state = { batch: { root, base }, config: { spec: 'SPEC.md' }, say() {} };
  let seen = null;
  state.guardServices = { runStaticChecks: async (_root, config) => {
    seen = config.staticChecks;
    state.command = seen.replace(/^node [^ ]+compose\.js /u, '').split(' ').filter(Boolean);
    return { output: composeOutput(root, state, plan) };
  } };
  const composed = await composeOnRunner(state, plan);
  assert.match(seen, /compose\.js --base /u);
  assert.equal(sh('rev-parse', 'HEAD'), composed.tip, 'the checkout sits on the returned commit');
  assert.equal(sh('rev-parse', 'HEAD^1'), composed.merges.get(1), 'the second merge sits on the first');
  assert.equal(sh('rev-parse', `${composed.merges.get(1)}^1`), base, 'the first merge sits on the base');
  assert.match(readFileSync(join(root, LEAF), 'utf8'), /FEATURE_ENGINE = 81;/u, 'the derived engine number rides the returned commit');
  assert.ok(readFileSync(join(root, 'web/a.txt'), 'utf8'));
  assert.deepEqual(composed.assigned, [{ name: 'FEATURE_ENGINE', number: 81 }]);
  assert.equal(composed.merges.get(2), composed.tip, 'the last item merge is amended with the derived files');
  assert.ok(composed.writes.includes(LEAF));
  for (const entry of plan) runFixtureGit(['merge-base', '--is-ancestor', entry.commit, composed.tip], { cwd: root });
});

test('landing.derive.composeonrunner-hands-the-batch-back-to: composeOnRunner hands the batch back to a local merge when the runner could not compose it [C7,#5585]', async t => {
  const { root, sh, base, plan } = composeRepo(t);
  for (const output of ['LANDING_COMPOSE_UNAVAILABLE\n', 'LANDING_COMPOSE_CONFLICT=2\n', '']) {
    const state = { batch: { root, base }, config: {}, say() {}, guardServices: { runStaticChecks: async () => ({ output }) } };
    assert.equal(await composeOnRunner(state, plan), null);
    assert.equal(sh('rev-parse', 'HEAD'), base, 'the checkout stays on the base');
  }
});

test('landing.derive.composeonrunner-refuses-a-returned-commit-that: composeOnRunner refuses a returned commit that does not carry every planned item [C7,#5585]', async t => {
  const { root, sh, base, plan } = composeRepo(t);
  const output = `LANDING_COMPOSE_MERGES=[]\nLANDING_COMPOSE_TIP=${plan[0].commit}\n`;
  const state = { batch: { root, base }, config: {}, say() {}, guardServices: { runStaticChecks: async () => ({ output }) } };
  assert.equal(await composeOnRunner(state, plan), null);
  assert.equal(sh('rev-parse', 'HEAD'), base);
});

const CEILINGS = 'apps/cli/journeys/imports/closure-budget.json';
const TIGHTEN = 'apps/cli/journeys/imports/tighten.js';
/** A stand-in tighten script: lowers the `show` row to 3 and exits with `status`. */
const standIn = status => `import { readFileSync, writeFileSync } from 'node:fs';\nconst rows = JSON.parse(readFileSync('${CEILINGS}', 'utf8'));\nrows.show = 3;\nwriteFileSync('${CEILINGS}', JSON.stringify(rows, null, 2) + '\\n');\nprocess.exit(${status});\n`;

/** The repo with a committed ceilings file (and, when `status` is given, the stand-in script) on top. */
function tightenRepo(t, status) {
  const { root, sh } = repo(t);
  mkdirSync(join(root, dirname(CEILINGS)), { recursive: true });
  writeFileSync(join(root, CEILINGS), '{\n  "show": 10,\n  "status": 20\n}\n');
  if (status !== undefined) writeFileSync(join(root, TIGHTEN), standIn(status));
  sh('add', '-A');
  sh('commit', '-q', '-m', 'ceilings');
  return { root, sh };
}

test('landing.derive.closure-tighten-staged: stageLandingDerived stages the lowered closure ceilings file when the tighten script lowers a row [C7,#12053]', async t => {
  const { root, sh } = tightenRepo(t, 0);
  const { engines } = await stageLandingDerived(root);
  assert.ok(engines.files.includes(CEILINGS), engines.files.join(','));
  assert.deepEqual(sh('diff', '--cached', '--name-only').split('\n').filter(Boolean).sort(), [CEILINGS, LEAF].sort());
  assert.deepEqual(JSON.parse(readFileSync(join(root, CEILINGS), 'utf8')), { show: 3, status: 20 });
});

test('landing.derive.closure-tighten-absent-or-failing: a tree without the tighten script stages no ceilings file, and a failing script stages nothing and does not fail the derive [C7,#12053]', async t => {
  for (const status of [undefined, 1]) {
    const { root, sh } = tightenRepo(t, status);
    const { engines } = await stageLandingDerived(root);
    assert.ok(!engines.files.includes(CEILINGS), engines.files.join(','));
    assert.ok(!sh('diff', '--cached', '--name-only').includes(CEILINGS));
    assert.deepEqual(JSON.parse(readFileSync(join(root, CEILINGS), 'utf8')), { show: 10, status: 20 }, 'a failed run leaves the ceilings as committed');
  }
});

test('landing.derive.closure-tighten-derive-job-patch: the runner derive job prints a patch holding the lowered ceilings file [C7,#12053]', t => {
  const { root, sh } = tightenRepo(t, 0);
  const { root: twin } = privateFixtureFiles('landing-derive-tighten-');
  runFixtureGit(['clone', '-q', root, twin], { cwd: root });
  const ran = spawnSync(process.execPath, [DERIVE, '--tree', sh('rev-parse', 'HEAD^{tree}')], { cwd: twin, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  rmSync(twin, { recursive: true, force: true });
  assert.equal(ran.status, 0, ran.stderr);
  const patch = Buffer.from(ran.stdout.split('\n').find(line => line.startsWith('LANDING_DERIVE_PATCH=')).slice(21), 'base64').toString('utf8');
  assert.match(patch, /closure-budget\.json/u);
  assert.match(patch, /\+\s+"show": 3/u);
});
