/** Every CLI io built through the shared context gets a silent gate-wait reporter, so a handoff worker's gate wait never throws [C7]. */
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cliContext$context as context } from '../apps/cli/index.js';
import { runFixtureGit } from './fixture-child.js';

/** A real repository, because the context reads its repository identity. */
function repository(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-gate-wait-io-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root });
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
