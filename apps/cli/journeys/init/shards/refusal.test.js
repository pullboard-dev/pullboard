/** @pullboard-test-input source-tree */
import assert from 'node:assert/strict';
import {
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { landingSource } from '../../../../../packages/landing/index.js';
import {
  fixture,
  scenario,
  landingWithRunnerAnswer,
} from '../../../tests/fixtures/init/shards.js';

test('a runner refusal in a sharded landing is handled by its class [C7,V4]', { timeout: 300_000 }, async (t) => { // budget: five bounded landings on one fixture.
  const box = fixture();
  t.after(() => rmSync(box.dir, { recursive: true, force: true }));
  scenario(box, 'green-runner');
  // The pin covers untracked contents, not only their names: a same-name replacement changes it.
  const loose = join(box.repo, 'loose.txt');
  writeFileSync(loose, 'first\n');
  const before = landingSource(box.repo);
  writeFileSync(loose, 'second\n');
  assert.notEqual(landingSource(box.repo).fingerprint, before.fingerprint, 'an untracked file with new content changes the pin');
  rmSync(loose);
  const rerunLine = /^landing shard (\d\/\d): runner fixture-host failed mid-shard; rerunning shard \1 locally$/mu;

  // 1. A lost host or transport reruns the shard locally, named.
  const dropped = await landingWithRunnerAnswer(box, 'DROPPED', 3, 120_000);
  assert.equal(dropped.isGreen, true, dropped.output);
  assert.match(dropped.output, rerunLine);
  assert.match(dropped.output, /attempt 1 on fixture-host: infrastructure \(runner transport lost\)/u);

  // 2. Changed source: the code under test drifted, so the landing fails by name with no retry.
  const drifted = await landingWithRunnerAnswer(box, 'RUNNER_SOURCE_CHANGED', 3, 120_000);
  assert.equal(drifted.isGreen, false, drifted.output);
  assert.match(drifted.output, /attempt 1 on fixture-host: refused \(runner refused: RUNNER_SOURCE_CHANGED\) in \d+ ms$/mu);
  assert.match(drifted.output, /^landing shard \d\/3: runner fixture-host refused it: \[RUNNER_SOURCE_CHANGED\] runner fixture-host answered/mu);
  assert.doesNotMatch(drifted.output, rerunLine, 'changed source is never retried');
  assert.equal(drifted.calls.length, 1);
  assert.equal(drifted.profile.shards.filter(shard => shard.status === 'stopped').length, 2, 'the other shards stop');

  // 3. Unverified cleanup reruns locally but takes the host out of this landing: no more shards go to it.
  const unverified = await landingWithRunnerAnswer(box, 'RUNNER_CLEANUP_TIMEOUT', 4, 150_000);
  assert.equal(unverified.isGreen, true, unverified.output);
  assert.match(unverified.output, rerunLine);
  // The quarantine and its inspect instruction come before the shard is retried anywhere.
  assert.ok(unverified.output.indexOf('quarantined for the rest of this landing') < unverified.output.search(rerunLine),
    `the host is quarantined before the retry\n${unverified.output}`);
  assert.match(unverified.output, /^landing runner fixture-host quarantined for the rest of this landing: \[RUNNER_CLEANUP_TIMEOUT\] .*inspect job fixture-job under its runner namespace before another run$/mu);
  assert.deepEqual(unverified.calls, ['fixture-host'], 'the quarantined host gets no second shard');
  assert.deepEqual(unverified.profile.quarantined.map(entry => entry.host), ['fixture-host']);
  assert.ok(unverified.profile.shards.filter(shard => shard.status === 'green').every(shard => shard.host === 'local'));

  // 4. A setup the runner's own pool refused (#690) reruns locally, with the code and host in the log.
  const setup = await landingWithRunnerAnswer(box, 'RUNNER_SETUP_REFUSED', 3, 120_000);
  assert.equal(setup.isGreen, true, setup.output);
  assert.match(setup.output, rerunLine);
  assert.match(setup.output, /attempt 1 on fixture-host: infrastructure \(runner refused: RUNNER_SETUP_REFUSED\)/u);
  assert.match(setup.output, /^landing shard \d\/3: runner fixture-host refused it: \[RUNNER_SETUP_REFUSED\]/mu);

  // 5. A refusal this landing does not know fails closed: red, named, and never silently retried.
  const unknown = await landingWithRunnerAnswer(box, 'RUNNER_SOMETHING_NEW', 3, 120_000);
  assert.equal(unknown.isGreen, false, unknown.output);
  assert.match(unknown.output, /attempt 1 on fixture-host: refused \(runner refused: RUNNER_SOMETHING_NEW\)/u);
  assert.doesNotMatch(unknown.output, rerunLine);

  // 6. A transport-loss rerun runs only the landing's pinned source: when the checkout changed
  // under the landing, the rerun refuses by name instead of testing other code.
  const edited = join(box.repo, 'test/f.test.js');
  const original = readFileSync(edited, 'utf8');
  try {
    const moved = await landingWithRunnerAnswer(box, 'DROPPED_AFTER_EDIT', 3, 120_000);
    assert.equal(moved.isGreen, false, moved.output);
    assert.match(moved.output, /^landing shard \d\/3: \[LANDING_SOURCE_CHANGED\] the checkout changed from the landing's pinned source [0-9a-f]{12} /mu);
    assert.match(moved.output, /: refused \(landing refused: LANDING_SOURCE_CHANGED\) in \d+ ms$/mu);
    assert.doesNotMatch(moved.output, /attempt 2 on local: green/u, 'no green result comes from the changed checkout');
  } finally { writeFileSync(edited, original); }
});
