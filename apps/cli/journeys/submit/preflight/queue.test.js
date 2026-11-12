/** Submit runs the configured static check in the agent's checkout before queueing; a red one queues no runner [V4,C7,#5730]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { builderRepo } from '../../../tests/fixtures/submit/gate.js';
import { commitAll } from '../../../tests/fixtures/submit/gate.js';
import { privateRepo } from '../../../tests/fixtures/submit/gate.js';
import { put } from '../../../tests/fixtures/submit/gate.js';
import { runCliInProcess } from '../../../tests/fixtures/process.js';

const GATE_FRONT_DOOR = fileURLToPath(new URL('../../../../../packages/gate/index.js', import.meta.url));
const REFUSED = /preflight is red; no runner was queued/u;

/** A joined builder holding one claim, in a project whose config is `config` plus the files in `files`. */
function project(t, config, files = {}) {
  const box = privateRepo(t);
  put(box.root, 'pullboard.json', JSON.stringify({ gate: 'true', affectedTests: 'node --test', submitGate: 'landing', shared: ['pullboard.json'], ...config }));
  put(box.root, 'src/a.js', 'export const a = 1;\n');
  for (const [path, text] of Object.entries(files)) put(box.root, path, text);
  commitAll(box);
  const builder = builderRepo(box);
  assert.equal(builder.coordinator('add', 'build', 'Static preflight fixture', '--criterion', 'the fixture change is submitted or refused', '--brief', 'Files: src/a.js\nTest: submit refuses or proceeds', '--check', 'true', '--route', 'mid', '--wait').code, 0);
  assert.equal(builder.run('claim', '1').code, 0);
  return builder;
}

/** The submit handoff refs queued in this repository: one per runner-bound job. */
function queuedJobs(box) { return box.git('for-each-ref', '--format=%(refname)', 'refs/pullboard/submit-handoffs/').trim(); }

/** Run one CLI call in this process as the joined builder, so a submit costs no extra node launch. */
async function inProcess(builder, ...args) {
  const result = await runCliInProcess(args, { cwd: builder.root, env: builder.env });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

/** Submit item 1 and return the refusal text, asserting it refused GATE_RED with no job queued and the claim kept. */
async function refusedBeforeQueue(box) {
  const refused = await inProcess(box, 'submit', '1', '--json', '--infra', 'static preflight fixture');
  assert.notEqual(refused.code, 0, refused.err + refused.out);
  assert.match(refused.err + refused.out, /GATE_RED/u);
  assert.match(refused.err + refused.out, REFUSED);
  assert.equal(queuedJobs(box), '', 'no submit job was queued for a runner');
  assert.equal(JSON.parse((await inProcess(box, 'show', '1', '--json')).out).item_status, 'claimed');
  return refused.err + refused.out;
}

test('clause 1: with handoff on, a red static check refuses GATE_RED in the agent checkout before enqueueSubmitHandoff [V4,C7]', { timeout: 180_000 }, async t => {
  const box = project(t, { staticChecks: 'node --experimental-vm-modules apps/cli/src/io/static/checks.js', submit: { handoff: true } }, {
    'packages/gate/data/baselines/test-waits-baseline.json': '{}\n',
    'apps/cli/src/io/static/checks.js': `import { importStyleViolations } from ${JSON.stringify(GATE_FRONT_DOOR)};\nprocess.exitCode = importStyleViolations([]).length;\n`,
  });
  // A fixed wait in a test is a registered static failure, and test is the build lane's own folder.
  put(box.root, 'test/w.test.js', 'await new Promise(resolve => setTimeout(resolve, 500));\n');
  commitAll(box, 'feat(core): add a test with a fixed wait [G1]');
  assert.match(await refusedBeforeQueue(box), /test-waits: /u);
});

test('clause 2: any repo\'s configured static check runs before the queue, red refuses and green proceeds [V4,C7]', { timeout: 180_000 }, async t => {
  // Another project's own linter: no Pullboard checker anywhere in its command.
  const lint = "import { readFileSync } from 'node:fs';\nif (readFileSync('src/a.js', 'utf8').includes('TODO')) { console.error('lint: src/a.js has a TODO'); process.exit(1); }\n";
  const box = project(t, { staticChecks: 'node lint.mjs', submit: { handoff: true } }, { 'lint.mjs': lint });
  put(box.root, 'src/a.js', 'export const a = 2; // TODO\n');
  commitAll(box, 'feat(core): leave a TODO [G1]');
  assert.match(await refusedBeforeQueue(box), /lint: src\/a\.js has a TODO/u);
  // With handoff off the in-process submit refuses the same way before its gate stages start.
  const local = project(t, { staticChecks: 'node lint.mjs' }, { 'lint.mjs': lint });
  put(local.root, 'src/a.js', 'export const a = 2; // TODO\n');
  commitAll(local, 'feat(core): leave a TODO [G1]');
  assert.match(await refusedBeforeQueue(local), /lint: src\/a\.js has a TODO/u);
  put(local.root, 'src/a.js', 'export const a = 3;\n');
  commitAll(local, 'feat(core): clear the TODO [G1]');
  const accepted = await inProcess(local, 'submit', '1', '--json', '--infra', 'static preflight fixture');
  assert.equal(accepted.code, 0, accepted.err + accepted.out);
});
