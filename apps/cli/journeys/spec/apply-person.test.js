/** spec apply --row --commit on the person channel applies only a row that channel just approved [C7,#9627]. */
/** @pullboard-test-input source-cell apps/cli apps/lib store */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { fixtureSettledMachine } from '../../../../packages/gate/tests/fixtures/testkit.js';
import { parseSpec } from '../../../../packages/spec/index.js';

const fixtures = createE2eHelpers();
after(fixtures.cleanup);

/** Run the production dispatcher in this process as if the person's channel (the view) made the call. */
function onChannel(box, cwd, channel, ...args) {
  return runCliInProcess(args, { cwd, env: box.env, personChannel: channel });
}

/** Require a successful real command and retain its diagnostics on failure. */
function succeeds(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
}

/** The refusal code of a failed --json command. */
function refusedWith(result) {
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout).error.code;
}

/** Read one requirement from the fixture's current SPEC bytes. */
function row(box, id) {
  return parseSpec(readFileSync(join(box.repo, 'SPEC.md'), 'utf8')).rows.find(entry => entry.id === id);
}

/** A lane proposes a revision of an approved row; the person then approves it on the given channel (terminal when none). */
async function proposed(box, channel, text = 'The page renders accessibly.', target = 'G1') {
  const draft = JSON.parse(succeeds(await box.runIn(box.web, 'spec', 'draft', text,
    '--revises', target, '--gate', 'true', '--reason', 'Reworded.', '--json')).out);
  if (channel) succeeds(await onChannel(box, box.repo, channel, 'spec', 'approve', draft.id));
  else succeeds(await box.runIn(box.repo, 'spec', 'approve', draft.id));
}

test('clause 1: on the view channel, spec apply --row G1 --commit succeeds for a row whose pending approve that channel recorded [C7,#9627]', { timeout: 180_000 }, async () => {
  const box = fixtures.project('true');
  await proposed(box, 'view');
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, { spec: { commitOnApply: true } });
  const applied = JSON.parse(succeeds(await onChannel(box, box.repo, 'view', 'spec', 'apply', '--row', 'G1', '--commit', '--json')).stdout).applied;
  assert.equal(applied.committed, true);
  assert.equal(row(box, 'G1').text, 'The page renders accessibly.');
});

test('clause 2: on the view channel the same call refuses COORDINATOR_ONLY with no pending decision, one decided on another channel, or no --commit [C7,#9627]', { timeout: 180_000 }, async () => {
  const box = fixtures.project('true');
  const before = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  const call = (...flags) => onChannel(box, box.repo, 'view', 'spec', 'apply', ...flags, '--json');
  assert.equal(refusedWith(await call('--row', 'G1', '--commit')), 'COORDINATOR_ONLY', 'no pending decision');
  await proposed(box);
  assert.equal(refusedWith(await call('--row', 'G1', '--commit')), 'COORDINATOR_ONLY', 'decided on the terminal, not this channel');
  assert.equal(readFileSync(join(box.repo, 'SPEC.md'), 'utf8'), before, 'the refusals so far left the row file as it was');
  await proposed(box, 'view', 'The API answers quickly.', 'G2');
  const mid = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  assert.equal(refusedWith(await call('--row', 'G2')), 'COORDINATOR_ONLY', 'no --commit');
  assert.equal(refusedWith(await call('--commit')), 'COORDINATOR_ONLY', 'no --row');
  assert.equal(readFileSync(join(box.repo, 'SPEC.md'), 'utf8'), mid, 'the later refusals left the row file as it was');
});

test('clause 3: a seat channel still refuses COORDINATOR_ONLY for the same call [C7,#9627]', { timeout: 180_000 }, async () => {
  const box = fixtures.project('true');
  await proposed(box, 'view');
  const seat = await box.runIn(box.web, 'spec', 'apply', '--row', 'G1', '--commit', '--json');
  assert.equal(refusedWith(seat), 'COORDINATOR_ONLY');
  const seatOnChannel = await onChannel(box, box.web, 'view', 'spec', 'apply', '--row', 'G1', '--commit', '--json');
  assert.equal(refusedWith(seatOnChannel), 'COORDINATOR_ONLY', 'a view call from a lane seat is no main-checkout apply');
});
