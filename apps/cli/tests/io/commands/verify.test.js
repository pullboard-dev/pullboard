/** @pullboard-test-input apps/cli/src/io/commands/verify.js */
/** A strict item's accept states what the reviewer broke: refused without --broke, recorded with it, and unchanged for reject and for items that do not require it [C7,#12047]. */
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { provenBreakStatement } from '../../../src/io/commands/verify.js';
import { soloLowStakesFacts } from '../../../src/io/commands/verify.js';
import { refuseLinkedDependencies } from '../../../src/io/commands/verify.js';
import { verdictIsolation } from '../../../src/io/commands/verify.js';
import { fileFixtureItem } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { fixtureProjectPolicy } from '../../fixtures/testkit.js';
import { fixtureMachineSettings } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { joinFixtureSeat } from '../../../../../packages/gate/tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

const BROKE = 'ran node --test on the changed file with the guard removed and the case failed';

/** A submitted item on a board whose review.requireProvenBreak is set as named, or left unset. */
function submitted(requireProvenBreak) {
  const box = e2e.privateCheckSubmission({ check: 'true' });
  if (requireProvenBreak !== undefined) {
    const config = { ...JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8')), review: { requireProvenBreak } };
    fixtureProjectPolicy(box.repo, { config });
    box.git(box.repo, 'add', 'pullboard.json');
    box.git(box.repo, 'commit', '-q', '-m', 'chore: set review.requireProvenBreak');
    // The reviewing seat reads the board policy from its own checkout.
    copyFileSync(join(box.repo, 'pullboard.json'), join(box.review, 'pullboard.json'));
  }
  return box;
}

test('cli.io-commands-verify.strict-accept-needs-break: clause 1: on a strict item verify accept without --broke is refused PROVEN_BREAK_REQUIRED with the flag in its next line and records nothing, with a 40-character --broke it accepts and the statement is on the item thread [C7,#12047]', async () => {
  for (const broke of [undefined, '', 'too short']) {
    assert.throws(() => provenBreakStatement(true, broke), error => error.code === 'PROVEN_BREAK_REQUIRED' && /--broke/u.test(error.message) && /nothing was recorded/u.test(error.message));
  }
  assert.equal(provenBreakStatement(true, BROKE), BROKE);
  assert.equal(provenBreakStatement(false, undefined), '');
  const box = submitted(undefined);
  const accepted = await box.runLocal(box.review, 'verify', '1', 'accept', '--note', 'read the diff against the bar', '--broke', BROKE, '--json');
  assert.equal(accepted.code, 0, accepted.stdout + accepted.stderr);
  const shown = await box.runLocal(box.review, 'show', '1', '--detail');
  assert.match(shown.stdout, new RegExp(`proven break: ${BROKE}`, 'u'));
});

test('cli.io-commands-verify.strict-reject-unchanged: clause 1: a reject on an item whose review requires a proven break needs no --broke [C7,#12047]', async () => {
  const box = submitted(true);
  const rejected = await box.runLocal(box.review, 'verify', '1', 'reject', '--reason', 'BEHAVIOR_MISMATCH', '--clause', 'The page renders.', '--note', 'the diff skips the bar clause', '--json');
  assert.doesNotMatch(rejected.stdout + rejected.stderr, /PROVEN_BREAK_REQUIRED/u);
  assert.equal(rejected.code, 0, rejected.stdout + rejected.stderr);
});

test('cli.io-commands-verify.steady-accept-unchanged: clause 1: a steady item with the setting unset accepts without --broke [C7,#12047]', async () => {
  const box = submitted(undefined);
  const accepted = await box.runLocal(box.review, 'verify', '1', 'accept', '--note', 'read the diff against the bar', '--json');
  assert.equal(accepted.code, 0, accepted.stdout + accepted.stderr);
});

test('cli.io-commands-verify.deps-outside-tree-refused: refuseLinkedDependencies throws DEPS_OUTSIDE_TREE naming each linked package and returns quietly for an in-tree entry [C7,#1112]', (t) => {
  const dir = privateFixtureFiles('verify-deps-').root;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const folder = join(dir, 'review');
  const outside = join(dir, 'elsewhere');
  mkdirSync(join(folder, 'node_modules', 'kept-pkg'), { recursive: true });
  mkdirSync(outside);
  refuseLinkedDependencies(folder);
  symlinkSync(outside, join(folder, 'node_modules', 'left-pad'));
  assert.throws(() => refuseLinkedDependencies(folder), (error) => error.code === 'DEPS_OUTSIDE_TREE' && error.message.includes('left-pad') && !error.message.includes('kept-pkg'));
});

test('cli.io-commands-verify.isolated-flag: verdictIsolation is true for a check run in the board-made review folder or one proven by a runner receipt at the submitted commit, and false otherwise [C7,#1112]', () => {
  const commit = 'a'.repeat(40);
  assert.equal(verdictIsolation({ folder: '/review/one', reviewFolder: '/review/one', commit, receipt: null }), true);
  assert.equal(verdictIsolation({ folder: '/seat', reviewFolder: null, commit, receipt: { commit } }), true);
  assert.equal(verdictIsolation({ folder: '/seat', reviewFolder: null, commit, receipt: null }), false);
  assert.equal(verdictIsolation({ folder: '/seat', reviewFolder: '/review/one', commit, receipt: { commit: 'b'.repeat(40) } }), false);
});

const FROZEN = JSON.stringify({ rows: [{ id: 'C7' }, { id: 'U148', stakes: 'low' }] });

test('cli.io-commands-verify.solo-facts-off-by-default: soloLowStakesFacts returns nothing unless enabled is exactly true [C7,#966]', () => {
  assert.deepEqual(soloLowStakesFacts({ item_frozen: FROZEN }, undefined), {});
  assert.deepEqual(soloLowStakesFacts({ item_frozen: FROZEN }, false), {});
  assert.deepEqual(soloLowStakesFacts({ item_frozen: FROZEN }, 'true'), {});
  assert.deepEqual(soloLowStakesFacts({ item_frozen: FROZEN }, 1), {});
});

test('cli.io-commands-verify.solo-facts-from-frozen-rows: when enabled it returns one row per frozen row, a row without stakes read as team [C7,#966]', () => {
  assert.deepEqual(soloLowStakesFacts({ item_frozen: FROZEN }, true), { soloLowStakes: true, rows: [{ id: 'C7', stakes: 'team' }, { id: 'U148', stakes: 'low' }] });
});

test('cli.io-commands-verify.solo-facts-never-invent-a-row: an empty, unparseable or row-less frozen record returns nothing even when enabled [C7,#966]', () => {
  assert.deepEqual(soloLowStakesFacts({ item_frozen: '' }, true), {});
  assert.deepEqual(soloLowStakesFacts({ item_frozen: null }, true), {});
  assert.deepEqual(soloLowStakesFacts({ item_frozen: '{not json' }, true), {});
  assert.deepEqual(soloLowStakesFacts({ item_frozen: '{"rows":[]}' }, true), {});
  assert.deepEqual(soloLowStakesFacts({ item_frozen: '{"check":"x"}' }, true), {});
});

const GREEN_RUN = { checked: true, state: 'pass' };
const RED_BASELINE = { result: 'red', command: 'node --test x' };
const FROZEN_LOW = { item_frozen: JSON.stringify({ rows: [{ id: 'U148', stakes: 'low' }, { id: 'C7', stakes: 'low' }] }), item_check: 'node --test x' };
const SOUND = { baselinePending: false, baselineInvalid: false, rows: [] };

test('cli.io-commands-verify.solo-person-approval: soloLowStakesFacts marks a row personApproved only when the spec approval state does not list it as agent-approved, so a row an agent changed reads as not approved [C7,#966]', () => {
  const facts = soloLowStakesFacts(FROZEN_LOW, true, { approval: SOUND, baseline: RED_BASELINE, check: GREEN_RUN });
  assert.deepEqual(facts.rows, [{ id: 'U148', stakes: 'low', personApproved: true }, { id: 'C7', stakes: 'low', personApproved: true }]);
  const lowered = soloLowStakesFacts(FROZEN_LOW, true, { approval: { ...SOUND, rows: [{ id: 'C7' }] }, baseline: RED_BASELINE, check: GREEN_RUN });
  assert.deepEqual(lowered.rows.map((row) => row.personApproved), [true, false]);
  for (const approval of [undefined, { ...SOUND, baselinePending: true }, { ...SOUND, baselineInvalid: true }, { rows: undefined }]) {
    const unread = soloLowStakesFacts(FROZEN_LOW, true, { approval, baseline: RED_BASELINE, check: GREEN_RUN });
    assert.deepEqual(unread.rows.map((row) => row.personApproved), [false, false]);
  }
});

test('cli.io-commands-verify.solo-green-after-pass: soloLowStakesFacts sets greenAfter when the verify check result is checked with state pass, the state every real check path returns, and not for a never-run check or a green-named state [C7,#12482]', () => {
  const greenAfter = (check) => soloLowStakesFacts(FROZEN_LOW, true, { approval: SOUND, baseline: RED_BASELINE, check }).checks[0].greenAfter;
  assert.equal(greenAfter({ checked: true, state: 'pass' }), true);
  assert.equal(greenAfter({ checked: false, state: 'pass' }), false);
  assert.equal(greenAfter({ checked: true, state: 'fail' }), false);
  assert.equal(greenAfter({ checked: true, state: 'green' }), false);
});

test('cli.io-commands-verify.solo-check-facts: soloLowStakesFacts takes redBefore from the board baseline and greenAfter and machineRun from the check verify ran [C7,#966]', () => {
  const checksOf = (evidence) => soloLowStakesFacts(FROZEN_LOW, true, { approval: SOUND, ...evidence }).checks;
  assert.deepEqual(checksOf({ baseline: RED_BASELINE, check: GREEN_RUN }), [{ machineRun: true, redBefore: true, greenAfter: true }]);
  assert.deepEqual(checksOf({ baseline: null, check: GREEN_RUN }), [{ machineRun: true, redBefore: false, greenAfter: true }]);
  assert.deepEqual(checksOf({ baseline: { result: 'green' }, check: GREEN_RUN }), [{ machineRun: true, redBefore: false, greenAfter: true }]);
  assert.deepEqual(checksOf({ baseline: RED_BASELINE, check: { checked: false, state: 'pass' } }), [{ machineRun: false, redBefore: false, greenAfter: false }]);
  assert.deepEqual(checksOf({ baseline: RED_BASELINE, check: { checked: true, state: 'red' } }), [{ machineRun: true, redBefore: true, greenAfter: false }]);
  assert.deepEqual(soloLowStakesFacts({ ...FROZEN_LOW, item_check: '' }, true, { approval: SOUND, baseline: RED_BASELINE, check: GREEN_RUN }).checks, []);
  assert.deepEqual(soloLowStakesFacts(FROZEN_LOW, false, { approval: SOUND, baseline: RED_BASELINE, check: GREEN_RUN }), {});
});

/** A web-1 item frozen on spec row G1 written low, submitted and waiting, with verify.soloLowStakes on for the machine. */
async function frozenLowItem() {
  const box = e2e.project('true');
  const spec = readFileSync(join(box.repo, 'SPEC.md'), 'utf8');
  const stake = (text, stakes) => text.replace(/(- G1 \[approved, must\] .*?)( \| stakes: \w+)?\n/u, `$1 | stakes: ${stakes}\n`);
  const commitSpec = (stakes) => {
    fixtureProjectPolicy(box.repo, { config: JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8')), spec: stake(spec, stakes) });
    box.git(box.repo, 'add', 'SPEC.md');
    box.git(box.repo, 'commit', '-q', '-m', `docs: write G1 stakes ${stakes}`);
  };
  commitSpec('low');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  fileFixtureItem(box, box.repo, { lane: 'web', title: 'Low row', criterion: 'the page renders', check: 'true', args: ['--specs', 'G1'] });
  assert.equal((await box.runLocal(box.web, 'claim', '1')).code, 0);
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web/index.html'), 'fixture');
  e2e.historicalCheckSubmission(box, e2e.attackCommit(box, box.web));
  const current = JSON.parse(readFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), 'utf8'));
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { ...current, verify: { ...current.verify, soloLowStakes: true } });
  return { box, commitSpec };
}

test('cli.io-commands-verify.raised-stakes-self-accept: clause 1: a builder self-accept on an item frozen with a low row that main now writes as team is refused PENDING_REFREEZE naming the row and pullboard refreeze [C7,#1084]', async () => {
  const { box, commitSpec } = await frozenLowItem();
  commitSpec('team');
  const refused = await box.runLocal(box.web, 'verify', '1', 'accept', '--note', 'self accept on the old record');
  assert.notEqual(refused.code, 0);
  const text = refused.stdout + refused.stderr;
  assert.match(text, /PENDING_REFREEZE/u);
  assert.match(text, /G1/u);
  assert.match(text, /pullboard refreeze 1/u);
});

test('cli.io-commands-verify.raised-stakes-scope: clause 2: an independent verifier accept is not refused by the raised-stakes check, and a self-accept after pullboard refreeze meets the ordinary team-row SELF_VERIFY [C7,#1084]', async () => {
  const { box, commitSpec } = await frozenLowItem();
  const commit = box.git(box.web, 'rev-parse', 'HEAD').trim();
  commitSpec('team');
  const review = join(box.dir, 'raised-review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, commit);
  assert.equal(joinFixtureSeat(box, review, 'api').code, 0);
  const independent = await box.runLocal(review, 'verify', '1', 'accept', '--note', 'independent accept');
  assert.doesNotMatch(independent.stdout + independent.stderr, /PENDING_REFREEZE/u);
  const refrozen = await box.runLocal(box.repo, 'refreeze', '1');
  assert.equal(refrozen.code, 0, refrozen.stdout + refrozen.stderr);
  box.git(box.web, 'merge', '-q', '--no-edit', 'main');
  assert.equal((await box.runLocal(box.web, 'claim', '1')).code, 0);
  writeFileSync(join(box.web, 'web/second.html'), 'fixture');
  e2e.historicalCheckSubmission(box, e2e.attackCommit(box, box.web));
  const own = await box.runLocal(box.web, 'verify', '1', 'accept', '--note', 'self accept after the refreeze');
  assert.match(own.stdout + own.stderr, /SELF_VERIFY/u);
  assert.doesNotMatch(own.stdout + own.stderr, /PENDING_REFREEZE/u);
});
