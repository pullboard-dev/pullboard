/** @pullboard-test-input source-tree */
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
} from '../../../apps/cli/tests/fixtures/child.js';
import { commitDerived } from '../src/io/step/derive.js';

const DERIVE = fileURLToPath(new URL('../src/io/derive.js', import.meta.url));
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

test('commitDerived applies a runner patch that numbers the engine, without deriving on the coordinator [C7,#5568]', async t => {
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

test('commitDerived derives on the coordinator when the runner could not answer [C7,#5568]', async t => {
  const { root, sh } = repo(t);
  const said = [];
  const state = { batch: { root }, config: {}, say: line => said.push(line), guardServices: { runStaticChecks: async () => ({ output: 'LANDING_DERIVE_UNAVAILABLE\n' }) } };
  await commitDerived(state, [{ id: 1, merge: sh('rev-parse', 'HEAD') }], []);
  assert.match(readFileSync(join(root, LEAF), 'utf8'), /FEATURE_ENGINE = 81;/u);
  assert.match(said.join('\n'), /could not derive this batch/u);
});

test('the derive job writes the badge documents it is handed and counts held doctrine rules on the derived tree [C7,#5583]', async t => {
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

test('commitDerived hands the runner-counted doctrine rows to the landing and writes badges only in the job [C7,#5583]', async t => {
  const { root, sh } = repo(t);
  const output = `${runnerOutput(root, sh)}LANDING_DERIVE_RULES=[{"id":"D1","count":3,"found":2,"broken":null}]\n`;
  const state = { batch: { root }, config: {}, say() {}, guardServices: { runStaticChecks: async () => ({ output }) },
    board: {}, landingPorts: { badgeCounts: () => ({ items: 0 }), badgeDocuments: () => [], writeBadges: () => [] } };
  await commitDerived(state, [{ id: 1, merge: sh('rev-parse', 'HEAD') }], []);
  assert.deepEqual(state.measuredRules, [{ id: 'D1', count: 3, found: 2, broken: null }]);
});
