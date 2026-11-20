/** Every CLI io built through the shared context gets a silent gate-wait reporter, so a handoff worker's gate wait never throws [C7]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { waitForSubmitGate } from '../../../src/io/submit/wait.js';
import { submitHandoffRoot } from '../../../../../packages/sandbox/index.js';
import { cliContext$context as context } from '../../../index.js';
import { gateWaitReporter } from '../../../../../packages/gate/heavy.js';
import { takeResource } from '../../../../../packages/resources/index.js';
import { runFixtureGit } from '../../fixtures/child.js';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { fixtureProjectPolicy } from '../../fixtures/testkit.js';

/** A real repository with a minimal committed project config, because the context reads its repository identity and config. */
function repository(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-gate-wait-io-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root });
  fixtureProjectPolicy(root, { config: { gate: 'true', spec: 'SPEC.md', verify: 'any', lease: '2h', lanes: { web: { owns: ['web/'], specs: ['G1'] } } } });
  return root;
}

test('cli.io-submit-wait.an-io-built-the-way-the-submit: an io built the way the submit handoff worker builds it reports a gate wait without throwing [C7]', t => {
  const said = [];
  const io = { cwd: repository(t), say: line => said.push(line), err: () => {}, result: () => {} };
  const ctx = context(io);
  assert.equal(typeof ctx.io.gateWaitReporter, 'function', 'the worker io carries a reporter');
  const report = ctx.io.gateWaitReporter(ctx.io);
  assert.doesNotThrow(() => report({ holders: [], position: 1 }), 'a gate wait through the default reporter is silent');
  assert.deepEqual(said, []);
});

test('cli.io-submit-wait.a-reporter-the-caller-supplies-is-kept: control: a reporter the caller supplies is kept [C7]', t => {
  const supplied = () => () => {};
  const io = { cwd: repository(t), say: () => {}, err: () => {}, gateWaitReporter: supplied };
  assert.equal(context(io).io.gateWaitReporter, supplied);
});


test('cli.io-submit-wait.a-runner-only-gate-wait-reports-two: a runner-only gate wait reports two runner holders by host [C7]', async t => {
  const root = repository(t);
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(root, 'machine');
  t.after(() => {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previous;
  });
  const options = { name: 'gate', scope: 'machine', root, capacity: 0, remote: true, runnerOnly: true,
    runnerProvider: () => [{ host: '.51', slots: 2, browser: 0 }] };
  const first = await takeResource({ ...options, agent: 'first' });
  const second = await takeResource({ ...options, agent: 'second' });
  const lines = [];
  const report = gateWaitReporter({ say: line => lines.push(line) });
  const stop = new Error('observed wait');
  try {
    await assert.rejects(takeResource({ ...options, agent: 'waiting', onWait: state => { report(state); throw stop; } }), error => error === stop);
    assert.match(lines.join('\n'), /2 running; runners \.51: 2/);
  } finally { first.release(); second.release(); }
});

test('cli.io-submit-wait.waits-on-the-job-row-alone: clause 1: waitForSubmitGate on a board with no gate drive record and no hand-off ticket waits while the job row is queued or running, then returns 0 with the saved result when the row turns green [C7,V4]', async t => {
  const files = privateFixtureFiles('pullboard-wait-row-');
  t.after(() => rmSync(files.root, { recursive: true, force: true }));
  const commonDir = files.root;
  const jobId = '12345678-1234-4234-8234-123456789abc';
  const submitted = 'c'.repeat(40);
  const acknowledgment = { commit: submitted, tree: 't'.repeat(40) };
  const itemId = jobId.length / 4;
  assert.equal(submitHandoffRoot(commonDir, { id: jobId }), join(commonDir, 'pullboard', 'submit-handoffs', jobId, 'source'));
  files.write(`pullboard/submit-handoffs/${jobId}/submission.json`, JSON.stringify({ id: itemId, commit: submitted, gate: { report: 'all green' } }));
  const states = ['queued', 'running', 'running', 'green'];
  let reads = 0;
  const ports = {
    // The board holds nothing but the job row: no drive record table is touched, so none can be read.
    withBoardRead: (_ctx, work) => work({}),
    submitHandoff: () => ({ id: jobId, state: states[Math.min(reads++, states.length - 1)], commit: submitted, tree: acknowledgment.tree, digest: 'd', agentId: 'web-1', submitted, executionCommit: submitted, executionTree: acknowledgment.tree, gateGreen: true }),
    getItem: () => ({ item_frozen_digest: 'd', item_owner: 'web-1', item_status: 'claimed', item_built_by: 'web-1', item_commit: submitted }),
  };
  const said = [], results = [];
  const code = await waitForSubmitGate({ info: { commonDir }, io: { say: line => said.push(line), result: value => results.push(value) } }, itemId, acknowledgment, jobId, ports);
  assert.equal(code, 0);
  assert.ok(reads >= 4, `it kept waiting through queued and running: ${reads} reads`);
  assert.equal(results.length, 1);
  assert.deepEqual({ id: results[0].id, queued: results[0].queued, green: results[0].gate.green }, { id: itemId, queued: false, green: true });
  assert.match(said.join('\n'), /gate finished for #9: green/u);
});
