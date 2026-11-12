/** Independent signed-row recovery guidance follows the coordinator boundary for agent seats [S1,B26]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';

test('a stale signed approval keeps agent recovery requests with the coordinator [S1,B26]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const original = readFileSync(join(box.repo, 'SPEC.md'), 'utf8').replace('G1 [approved, must]', 'G1 [draft, must]');
  for (const root of [box.repo, box.web]) writeFileSync(join(root, 'SPEC.md'), original);
  const key = join(box.dir, 'review-signing-key');
  const made = runFixtureChild('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { env: box.env, encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  box.git(box.repo, 'config', 'user.signingkey', key);
  const signer = box.run(box.repo, 'spec', 'signers', 'add', '--key', key + '.pub', '--by', 'CO', '--json');
  assert.equal(signer.code, 0, `${signer.out}\n${signer.err}`);
  const approved = box.run(box.repo, 'spec', 'approve', 'G1', '--by', 'CO', '--json');
  assert.equal(approved.code, 0, `${approved.out}\n${approved.err}`);
  assert.ok(JSON.parse(approved.out).decisions[0].signature, 'the pending approval is genuinely signed');
  const changed = original.replace('| gate: web test', '| gate: web changed-test');
  assert.notEqual(changed, original);
  for (const root of [box.repo, box.web]) writeFileSync(join(root, 'SPEC.md'), changed);
  const resumed = box.run(box.web, 'resume', '--json');
  assert.equal(resumed.code, 0, `${resumed.out}\n${resumed.err}`);
  const setup = JSON.parse(resumed.out).setup;
  assert.match(setup.question, /coordinator/u, 'the actual joined agent is directed through its coordinator');
  assert.doesNotMatch(setup.question, /(?:^|[.;]\s*)ask the person\b/iu, 'a generated stale warning must not append a direct person request to agent guidance');
});
