/** Every CLI io built through the shared context gets a silent gate-wait reporter, so a handoff worker's gate wait never throws [C7]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cliContext$context as context } from '../../../index.js';
import { gateWaitReporter } from '../../../../../packages/gate/index.js';
import { takeResource } from '../../../../../packages/resources/index.js';
import { runFixtureGit } from '../../fixtures/child.js';
import { fixtureProjectPolicy } from '../../fixtures/testkit.js';

/** A real repository with a minimal committed project config, because the context reads its repository identity and config. */
function repository(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-gate-wait-io-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root });
  fixtureProjectPolicy(root, { config: { gate: 'true', spec: 'SPEC.md', verify: 'any', lease: '2h', lanes: { web: { owns: ['web/'], specs: ['G1'] } } } });
  return root;
}

test('an io built the way the submit handoff worker builds it reports a gate wait without throwing [C7]', t => {
  const said = [];
  const io = { cwd: repository(t), say: line => said.push(line), err: () => {}, result: () => {} };
  const ctx = context(io);
  assert.equal(typeof ctx.io.gateWaitReporter, 'function', 'the worker io carries a reporter');
  const report = ctx.io.gateWaitReporter(ctx.io);
  assert.doesNotThrow(() => report({ holders: [], position: 1 }), 'a gate wait through the default reporter is silent');
  assert.deepEqual(said, []);
});

test('control: a reporter the caller supplies is kept [C7]', t => {
  const supplied = () => () => {};
  const io = { cwd: repository(t), say: () => {}, err: () => {}, gateWaitReporter: supplied };
  assert.equal(context(io).io.gateWaitReporter, supplied);
});


test('a runner-only gate wait reports two runner holders by host [C7]', async t => {
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
