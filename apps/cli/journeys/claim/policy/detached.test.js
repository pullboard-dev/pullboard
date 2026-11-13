/** Detached review keeps accepted-main criterion authority and exact policy refusal codes [V4,B6,C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { verificationCriterionDigest } from '../../../src/io/commands/verify.js';
import { Refused } from '../../../../../packages/kernel/light.js';

/** Require each actual native fixture command to finish successfully. */
async function success(box, cwd, ...args) {
  const result = await box.runLocal(cwd, ...args);
  assert.equal(result.code, 0, result.err || result.out);
  return result;
}

/** Claim and submit a real item before moving the primary checkout as an independent reviewer does. */
async function submitted(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  await success(box, box.repo, 'add', 'web', 'Detached review', '--specs', 'G1', '--criterion', 'The page renders.');
  await success(box, box.web, 'claim', '1');
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web/page.html'), '<h1>Page</h1>\n');
  box.git(box.web, 'add', 'web/page.html');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): render page [G1]');
  await success(box, box.web, 'submit', '1', '--no-next');
  return box;
}

for (const decision of ['accept', 'reject']) {
  test(`a claimed frozen item can ${decision} from the detached primary without a policy mismatch [V4,B6]`, async t => {
    const box = await submitted(t);
    const before = JSON.parse((await success(box, box.repo, 'show', '1', '--json')).out);
    box.git(box.repo, 'switch', '-q', '--detach', box.git(box.web, 'rev-parse', 'HEAD'));
    const args = decision === 'accept' ? [] : ['--reason', 'BEHAVIOR_MISMATCH', '--clause', 'The page renders.'];
    await success(box, box.repo, 'verify', '1', decision, ...args, '--note', 'Actual detached-primary criterion control', '--as', 'coordinator', '--no-next');
    const after = JSON.parse((await success(box, box.repo, 'show', '1', '--json')).out);
    assert.equal(after.item_frozen_digest, before.item_frozen_digest);
    assert.equal(after.item_status, decision === 'accept' ? 'verified' : 'open');
  });
}

test('a detached old candidate cannot hide a changed approved row on accepted main [V4,B6]', async t => {
  const box = await submitted(t);
  // A person-approved Git edit can arrive without spec apply's atomic native refreeze.
  await success(box, box.repo, 'spec', 'approve', 'G1', '--text', 'The page renders a new heading.');
  const spec = join(box.repo, 'SPEC.md');
  writeFileSync(spec, readFileSync(spec, 'utf8').replace('The page renders.', 'The page renders a new heading.'));
  box.git(box.repo, 'add', 'SPEC.md');
  box.git(box.repo, 'commit', '-q', '-m', 'docs: advance accepted criterion [G1]');
  box.git(box.repo, 'switch', '-q', '--detach', box.git(box.web, 'rev-parse', 'HEAD'));
  const refused = await box.runLocal(box.repo, 'verify', '1', 'accept', '--note', 'Must retain current accepted rows', '--as', 'coordinator', '--no-next', '--json');
  assert.notEqual(refused.code, 0);
  assert.equal(JSON.parse(refused.out).error.code, 'CRITERIA_CHANGED');
  const shown = JSON.parse((await success(box, box.repo, 'show', '1', '--json')).out);
  assert.equal(shown.item_status, 'submitted', 'the stale candidate receives no acceptance');
});

test('verification preserves planted policy refusals rather than changing their code [V4,C7]', () => {
  for (const code of ['NO_POLICY', 'NO_CONFIG', 'BAD_CONFIG', 'MAIN_FACTS_BUSY', 'A5_GRAMMAR_VERSION']) {
    const refusal = new Refused(code, 'Planted policy refusal');
    assert.throws(() => verificationCriterionDigest(() => { throw refusal; }, {}), error => error === refusal);
  }
  assert.equal(verificationCriterionDigest(() => { throw new Refused('UNKNOWN_SPEC', 'A cited row is gone'); }, {}), 'missing');
  const unexpected = new Error('Unexpected provider failure');
  assert.throws(() => verificationCriterionDigest(() => { throw unexpected; }, {}), error => error === unexpected);
});
