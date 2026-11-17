/** A job no registered runner can supply the toolchain for is refused at the runner choice, naming it, and never queued [C7,#3970]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { takeResource } from '../../../../../packages/resources/index.js';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { unsuppliedToolchainsMessage } from '../../../../../packages/resources/src/io/runner/pick.js';

/** Isolate the machine resource SQLite database. */
function fixture(t) {
  const { root } = privateFixtureFiles('pullboard-toolchain-refusal-');
  const home = join(root, 'machine');
  mkdirSync(home);
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

/** Runner-only gate options over a fixture pool whose machine requires the named toolchains. */
function pool(root, runners, requiredToolchains) {
  return { name: 'gate', scope: 'machine', root, capacity: 0, remote: true, runnerOnly: true, runnerWaitMs: 3_600_000, runnerProvider: () => runners, runnerLoadPolicyProvider: () => ({ requiredToolchains }) };
}

const PLAIN = { host: 'plain-box', slots: 2, browser: 0 };
const EQUIPPED = { host: 'tool-box', slots: 2, browser: 0, toolchains: { node: '22' } };

test('clause 1: with no registered runner recording a required toolchain, the job is refused naming it [C7]', async t => {
  const root = fixture(t);
  await assert.rejects(
    takeResource({ ...pool(root, [PLAIN, EQUIPPED], 'node,cargo'), agent: 'needs-cargo', onWait: async () => { throw new Error('the waiter queued instead of being refused'); } }),
    error => error.code === 'RUNNER_TOOLCHAIN_MISSING' && /toolchain cargo\b/u.test(error.message) && /plain-box, tool-box/u.test(error.message) && /pullboard runner add/u.test(error.message));
});

test('clause 2: the refusal comes on the first poll, before the job joins the line [C7]', async t => {
  const root = fixture(t);
  const options = pool(root, [PLAIN], 'go');
  await assert.rejects(takeResource({ ...options, agent: 'first-poll' }), error => error.code === 'RUNNER_TOOLCHAIN_MISSING');
  const held = await takeResource({ ...options, runnerLoadPolicyProvider: () => ({}), runnerProvider: () => [PLAIN], agent: 'later' });
  assert.equal(held.line?.length ?? 0, 0, 'the refused job left no waiter behind');
  await held.release?.();
});

test('clause 1: a runner recording every required toolchain keeps the job eligible; blank requires nothing [C7]', () => {
  const refusedNames = (runners, text) => unsuppliedToolchainsMessage(runners, text)?.match(/toolchains? ([\w, ]+?) \(/u)[1] ?? null;
  assert.equal(refusedNames([PLAIN, EQUIPPED], 'node'), null);
  assert.equal(refusedNames([PLAIN], ''), null);
  assert.equal(refusedNames([], 'node'), null, 'no registered runner is a different refusal');
  assert.equal(refusedNames([PLAIN, EQUIPPED], 'node, cargo'), 'cargo');
  assert.equal(refusedNames([EQUIPPED, { host: 'b', slots: 1, browser: 0, toolchains: { cargo: '1' } }], 'node,cargo'), 'node, cargo', 'split across two runners: none has both');
});
