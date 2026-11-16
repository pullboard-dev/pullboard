/** A runner run never waits on queue priority while runner slots sit free, and a queued run keeps its captured commit [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';
import { takeResource } from '../../../../resources/index.js';
import { queuedSource } from '../../../index.js';

/** Six 18-slot runners and one 10-slot runner: the 118 slots of the 9 Nov fleet. */
const FLEET = [...[51, 52, 53, 54, 55, 56].map(n => ({ host: `fixture-${n}`, slots: 18, browser: 12 })), { host: 'fixture-studio-host', slots: 10, browser: 6 }];

/** A private machine home and one real repository whose resource database the requests share. */
function pool(t) {
  const files = privateFixtureFiles('pullboard-admission-free-');
  const repo = join(files.root, 'repo');
  mkdirSync(repo);
  runFixtureGit(['-C', repo, 'init', '-q', '-b', 'main']);
  runFixtureGit(['-C', repo, '-c', 'user.email=a@example.test', '-c', 'user.name=A', 'commit', '--allow-empty', '-qm', 'fixture']);
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(files.root, 'machine');
  mkdirSync(process.env.PULLBOARD_MACHINE_HOME);
  t.after(() => {
    if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous;
    rmSync(files.root, { recursive: true, force: true });
  });
  return { name: 'gate', scope: 'machine', root: repo, capacity: 0, remote: true, runnerOnly: true, runnerProvider: () => FLEET };
}

/** Take a slot that must be admitted on its first look: any wait fails the test. */
function admitNow(base, options) {
  return takeResource({ ...base, ...options, onWait: () => { throw new Error(`${options.agent} ${options.kind} waited while runner slots were free`); } });
}

test('clause 1: with runner slots free, a request is admitted at once whatever its queue rule; the one-test-per-seat rule binds only the last slots [C7]', async t => {
  const base = pool(t);
  const held = [];
  try {
    held.push(await admitNow(base, { agent: 'seat-a', kind: 'test' }));
    // The seat's second test would queue behind its first under the one-test-per-seat rule; with 117 slots free it runs.
    const second = await admitNow(base, { agent: 'seat-a', kind: 'test' });
    held.push(second);
    assert.ok(second.runner, 'it runs on a runner');
  } finally { for (const lease of held) lease.release(); }
});

test('clause 2: a pullboard test run and a gate both admit at once with 100 of 118 runner slots free, through the real admission path [C7]', async t => {
  const base = pool(t);
  const held = [];
  try {
    for (let n = 0; n < 18; n += 1) held.push(await admitNow(base, { agent: `busy-${n}`, kind: 'gate' }));
    for (const kind of ['test', 'gate']) {
      const lease = await admitNow(base, { agent: `fresh-${kind}`, kind });
      held.push(lease);
      assert.ok(lease.runner, `${kind} admitted on a runner`);
    }
  } finally { for (const lease of held) lease.release(); }
});

test('clause 3: a run queued from a checkout whose HEAD then moves still runs its captured commit, never RUNNER_SOURCE_CHANGED [C7]', () => {
  const files = privateFixtureFiles('pullboard-queued-source-');
  const git = args => runFixtureGit(['-C', files.root, '-c', 'user.email=a@example.test', '-c', 'user.name=A', ...args]);
  runFixtureGit(['-C', files.root, 'init', '-q', '-b', 'main']);
  files.write('a.txt', 'queued\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'queued source']);
  const captured = { commit: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']) };
  assert.deepEqual(queuedSource(files.root, captured), captured, 'at queue time the checkout holds the captured commit');
  // Main lands under the checkout after the run queued.
  writeFileSync(join(files.root, 'a.txt'), 'landed\n');
  git(['commit', '-qam', 'landed under the queued run']);
  assert.deepEqual(queuedSource(files.root, captured), captured, 'the run still executes the commit it captured');
  writeFileSync(join(files.root, 'a.txt'), 'dirty\n');
  assert.deepEqual(queuedSource(files.root, captured), captured, 'a dirty checkout never changes what a queued run executes');
  assert.equal(queuedSource(files.root, { commit: 'f'.repeat(40), tree: captured.tree }), null, 'a commit the object store lacks is still refused');
});
