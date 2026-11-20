/** The pre-commit hook's staged static check runs on a free runner first and on the host only when no runner answers [C7,#12570]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { cellRepo } from '../../../../../packages/store/tests/fixtures/cell.js';
import { stagedStaticProblems } from '../../../src/io/hook/static.js';
import { RUNNER_STAGED_CHECK } from '../../../src/io/hook/runner.js';
import { hookRunnerWanted } from '../../../src/io/hook/runner.js';
import { stagedCommit } from '../../../src/io/hook/runner.js';
import { stagedOnRunner } from '../../../src/io/hook/runner.js';

const FIXTURE_CHECK = 'apps/cli/tests/fixtures/hook/static.js';
const MAIN = 'a'.repeat(40);

/** A real repository with one staged file, and the hook context naming it. */
function stagedRepo(t) {
  const repo = cellRepo(t, { real: true });
  repo.put('src/one.js', 'export const one = 1;\n');
  execFileSync('git', ['add', 'src/one.js'], { cwd: repo.root });
  return { ...repo, ctx: { info: { root: repo.root } } };
}

/** A job view whose runner posted the check's receipt: green, or red with this output. */
function receiptView(output, green = false) {
  const phase = { status: green ? 0 : 1, tail: output };
  return { leaseOwner: 'studio-1', steps: [{ name: 'offered', payload: {} }, { name: 'receipt', payload: { runner: 'studio-1', receipt: { status: green ? 0 : 1, gate: { green, phases: [phase] } } } }] };
}

test('cli.io-hook-static.runner-answer-is-the-hook-answer: clause 1: with a free runner the hook reports the runner job\'s findings and never runs the check on the host [C7,#12570]', async t => {
  const { root, ctx } = stagedRepo(t);
  const asked = [];
  const env = { PULLBOARD_HOOK_STATIC: FIXTURE_CHECK, PULLBOARD_HOOK_COMPANION_PATHS: JSON.stringify(['src/two.js']) };
  const problems = await stagedStaticProblems(root, env, { ctx, main: MAIN, wanted: () => true,
    onRunner: async (given, options) => { asked.push({ given, options }); return ['src/one.js:1: found on the runner', 'src/two.js:3: a companion path']; } });
  assert.deepEqual(problems, ['src/one.js:1: found on the runner']);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].given, ctx);
  assert.equal(asked[0].options.main, MAIN);
  assert.equal(problems.some(line => line.includes('fixture static check ran in process')), false);
});

test('cli.io-hook-static.host-runs-when-no-runner-answers: clause 1: when no runner takes the job in time the host runs the staged check itself [C7,#12570]', async t => {
  const { root, ctx } = stagedRepo(t);
  const problems = await stagedStaticProblems(root, { PULLBOARD_HOOK_STATIC: FIXTURE_CHECK }, { ctx, main: MAIN, wanted: () => true, onRunner: async () => null });
  assert.deepEqual(problems, [`src/one.js:1: fixture static check ran in process ${process.pid}`]);
});

test('cli.io-hook-static.no-runner-no-wait: clause 1: a machine with no runner, or a hook with no context, never offers a job and runs the check on the host [C7,#12570]', async t => {
  const { root, ctx } = stagedRepo(t);
  let offered = 0;
  const onRunner = async () => { offered += 1; return []; };
  const env = { PULLBOARD_HOOK_STATIC: FIXTURE_CHECK };
  assert.equal((await stagedStaticProblems(root, env, { ctx, main: MAIN, wanted: () => false, onRunner })).length, 1);
  assert.equal((await stagedStaticProblems(root, env, { main: MAIN, wanted: () => true, onRunner })).length, 1);
  assert.equal(offered, 0);
  const gateCheck = { PULLBOARD_HOOK_STATIC: RUNNER_STAGED_CHECK };
  assert.equal(hookRunnerWanted(gateCheck, { settings: () => ({ runners: [{ host: 'studio' }] }), dispatch: () => 'pull' }), true);
  assert.equal(hookRunnerWanted(gateCheck, { settings: () => ({ runners: [] }), dispatch: () => 'pull' }), false);
  assert.equal(hookRunnerWanted(env, { settings: () => ({ runners: [{ host: 'studio' }] }), dispatch: () => 'pull' }), false);
});

test('cli.io-hook-static.staged-commit-holds-the-index: clause 1: the job\'s commit holds exactly the staged tree on top of HEAD [C7,#12570]', async t => {
  const { root, commit } = stagedRepo(t);
  const staged = stagedCommit(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(git('rev-parse', `${staged}^`), commit);
  assert.equal(git('rev-parse', `${staged}^{tree}`), git('write-tree'));
  assert.equal(git('rev-parse', 'HEAD'), commit);
});

test('cli.io-hook-static.runner-job-answers-or-falls-back: clause 1: stagedOnRunner returns a posted job\'s findings, and null with the job cancelled when no runner takes it in time [C7,#12570]', async t => {
  const { ctx } = stagedRepo(t);
  const run = async (views, extra = {}) => {
    const settled = [], offers = [];
    let clock = 0, read = 0;
    const answer = await stagedOnRunner(ctx, { main: MAIN, claimMs: 15_000, answerMs: 75_000, now: () => clock, wait: async ms => { clock += ms; },
      offer: async (_ctx, fields) => { offers.push(fields); return { job: 'test:1', ref: 'refs/pullboard/test/x' }; },
      read: async () => views[Math.min(read++, views.length - 1)], settle: async (_ctx, _offered, how) => { settled.push(how); }, ...extra });
    return { answer, settled, offers, clock };
  };
  const red = await run([{ steps: [] }, receiptView('node static.js\nsrc/one.js:4: a red finding\n')]);
  assert.deepEqual(red.answer, ['src/one.js:4: a red finding']);
  assert.deepEqual(red.settled, [{ cancel: false }]);
  assert.equal(red.offers[0].command, `git update-ref refs/heads/main ${MAIN} && git reset -q --soft HEAD~1 && node --experimental-vm-modules --disable-warning=ExperimentalWarning ./${RUNNER_STAGED_CHECK} --staged-hook`);
  assert.equal(red.offers[0].main, MAIN);
  assert.deepEqual((await run([receiptView('', true)])).answer, []);
  const unclaimed = await run([{ steps: [] }]);
  assert.equal(unclaimed.answer, null);
  assert.deepEqual(unclaimed.settled, [{ cancel: true }]);
  assert.equal(unclaimed.clock, 15_000);
  const broken = await run([receiptView('Error: cannot list accepted static sources')]);
  assert.equal(broken.answer, null);
  const refused = await run([], { offer: async () => { throw Object.assign(new Error('busy'), { code: 'BOARD_BUSY' }); } });
  assert.equal(refused.answer, null);
  assert.deepEqual(refused.settled, []);
});
