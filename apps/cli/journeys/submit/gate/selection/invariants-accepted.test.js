/** @pullboard-test-input source-tree */
/**
 * Accepted invariants cannot be edited away, deleted or duplicated at submit [V4,C7].
 */
import assert from 'node:assert/strict';
import { runFixtureGit } from '../../../../tests/fixtures/child.js';
import {
  existsSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import {
  join,
} from 'node:path';
import { test } from 'node:test';
import { runLocal } from '../local.js';
import { submitWithEnv } from '../local.js';
import { put } from '../../../../tests/fixtures/submit/gate.js';
import { project } from '../../../../tests/fixtures/submit/invariants.js';
import { change } from '../../../../tests/fixtures/submit/invariants.js';
import { unstamped } from '../../../../tests/fixtures/submit/invariants.js';

test("accepted-main invariants override the candidate, and a deleted one still refuses [V4,C7]", async (t) => {
  const trusted = await project(t, [], true);
  const acceptedRoot = join(trusted.box.dir, 'repo');
  const policy = JSON.parse(readFileSync(join(acceptedRoot, 'pullboard.json'), 'utf8'));
  policy.submitInvariants = ['test/invariant.test.js'];
  put(acceptedRoot, 'pullboard.json', JSON.stringify(policy));
  runFixtureGit(['add', 'pullboard.json'], { cwd: acceptedRoot, env: trusted.box.env });
  runFixtureGit(['commit', '-q', '-m', 'chore: require project invariant'], { cwd: acceptedRoot, env: trusted.box.env });
  trusted.box.git('merge', '--no-edit', 'main');
  const candidate = JSON.parse(readFileSync(join(trusted.box.root, 'pullboard.json'), 'utf8'));
  candidate.submitInvariants = ['test/c.test.js'];
  put(trusted.box.root, 'pullboard.json', JSON.stringify(candidate));
  change(trusted.box);
  const ignored = await submitWithEnv(t, trusted.box, (...args) => runLocal(trusted.box, ...args), ['--infra', 'the landing fixture edits its pullboard.json']);
  assert.notEqual(ignored.code, 0, 'accepted main policy overrides both the claim-time list and candidate edit');
  assert.match(ignored.err, /^proof failed: /u);
  assert.ok(existsSync(trusted.marker), 'the accepted-main invariant still ran');
  assert.doesNotMatch(ignored.err + ignored.out, /unrelated test must stay deferred/u);
  unstamped(trusted.box);

  const missing = await project(t, ['test/invariant.test.js']);
  rmSync(join(missing.box.root, 'test/invariant.test.js'));
  change(missing.box);
  const absent = await submitWithEnv(t, missing.box, (...args) => runLocal(missing.box, ...args), ['--infra', 'the landing fixture edits its pullboard.json']);
  assert.notEqual(absent.code, 0, 'deleting a mandatory file cannot make the guard disappear');
  // The pulled proof names the missing file in the runner's own error rather than the inline gate's wording.
  assert.match(absent.err, /Could not find '\.\/test\/invariant\.test\.js'/u);
  unstamped(missing.box);

  const named = await project(t, ['test/invariant.test.js', 'test/invariant.test.js']);
  change(named.box, false);
  const selected = await submitWithEnv(t, named.box, (...args) => runLocal(named.box, ...args), ['--infra', 'the landing fixture edits its pullboard.json']);
  assert.equal(selected.code, 0, selected.err);
  const receipt = selected.receipt;
  assert.equal(receipt.gate.full, false);
  assert.equal(receipt.gate.deferred, true);
  assert.deepEqual(receipt.gate.files, ['test/a.test.js', 'test/invariant.test.js']);
  assert.deepEqual(readFileSync(named.marker, 'utf8').trim().split('\n').sort(), ['invariant', 'selected'], 'selected and mandatory overlap runs once');
  assert.match(receipt.gate.report, /full suite deferred to the landing gate/u);
  unstamped(named.box);
});
