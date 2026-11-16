/** spec apply --row <id> --commit commits the applied row when spec.commitOnApply is on [C7,#9624]. */
/** @pullboard-test-input source-cell apps/cli apps/lib store */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureSettledMachine } from '../../../../packages/gate/tests/fixtures/testkit.js';
import { parseSpec } from '../../../../packages/spec/index.js';

const fixtures = createE2eHelpers();
after(fixtures.cleanup);

/** Require a successful real command and retain its diagnostics on failure. */
function succeeds(result) {
  assert.equal(result.code, 0, `${result.out}\n${result.err}`);
  return result;
}

/** Read one requirement from the fixture's current SPEC bytes. */
function row(box, id) {
  return parseSpec(readFileSync(join(box.repo, 'SPEC.md'), 'utf8')).rows.find(entry => entry.id === id);
}

/** Turn spec.commitOnApply on or off for this fixture machine. */
function commitOnApply(box, on) {
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, on ? { spec: { commitOnApply: true } } : {});
}

/** Propose a revision of an approved row and have the person approve it, leaving it pending apply. */
async function approvedProposal(box, target, text) {
  const draft = JSON.parse(succeeds(await box.runIn(box.web, 'spec', 'draft', text,
    '--revises', target, '--gate', 'true', '--reason', 'Reworded.', '--json')).out);
  succeeds(await box.runIn(box.repo, 'spec', 'approve', draft.id));
  return draft.id;
}

test('clause 1: spec apply --row G1 --commit --json on a clean checkout with spec.commitOnApply on returns applied { committed: true, commit } and git log shows that commit [C7,#9624]', { timeout: 180_000 }, async () => {
  const box = fixtures.project('true');
  await approvedProposal(box, 'G1', 'The page renders accessibly.');
  commitOnApply(box, true);
  const before = box.git(box.repo, 'rev-parse', 'HEAD');
  const applied = JSON.parse(succeeds(await box.runIn(box.repo, 'spec', 'apply', '--row', 'G1', '--commit', '--json')).out).applied;
  assert.equal(applied.committed, true);
  assert.match(applied.commit, /^[0-9a-f]{40}$/u);
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD'), applied.commit, 'the commit is the new head');
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD~1'), before, 'one commit on top of the old head');
  assert.equal(box.git(box.repo, 'log', '-1', '--format=%s'), 'spec: approve G1');
  assert.equal(row(box, 'G1').text, 'The page renders accessibly.');
  assert.equal(box.git(box.repo, 'status', '--porcelain'), '', 'the checkout is clean again');
});

test('clause 2: with a dirty checkout spec apply --row --commit refuses APPLY_NOT_COMMITTED naming the one command left and leaves the row file untouched [C7,#9624]', { timeout: 180_000 }, async () => {
  const box = fixtures.project('true');
  await approvedProposal(box, 'G1', 'The page renders accessibly.');
  commitOnApply(box, true);
  writeFileSync(join(box.repo, 'notes.txt'), 'unrelated work\n');
  const specBefore = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  const head = box.git(box.repo, 'rev-parse', 'HEAD');
  const refused = await box.runIn(box.repo, 'spec', 'apply', '--row', 'G1', '--commit');
  assert.notEqual(refused.code, 0);
  const text = `${refused.out}${refused.err}`;
  assert.match(text, /APPLY_NOT_COMMITTED/u);
  assert.match(text, /pullboard spec apply --row G1 --commit/u, 'it names the one command left');
  assert.equal(readFileSync(join(box.repo, 'SPEC.md'), 'utf8'), specBefore, 'the row file is untouched');
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD'), head, 'nothing was committed');
});

test('clause 3: with spec.commitOnApply off, --commit applies the row exactly as spec apply --row does and commits nothing [C7,#9624]', { timeout: 180_000 }, async () => {
  const box = fixtures.project('true');
  await approvedProposal(box, 'G1', 'The page renders accessibly.');
  commitOnApply(box, false);
  const head = box.git(box.repo, 'rev-parse', 'HEAD');
  const applied = JSON.parse(succeeds(await box.runIn(box.repo, 'spec', 'apply', '--row', 'G1', '--commit', '--json')).out).applied;
  assert.equal(applied.committed, false);
  assert.equal(row(box, 'G1').text, 'The page renders accessibly.', 'the row is applied');
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD'), head, 'no commit was made');
  assert.match(box.git(box.repo, 'status', '--porcelain'), /SPEC\.md/u, 'the applied row waits uncommitted, as before');
});
