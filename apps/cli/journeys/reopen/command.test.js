/** @pullboard-test-input source-tree */
/** The reopen command end to end: its printed result, its landing flow and the retained main policy it reads [V2,V6,H16]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { commitFile } = e2e;

/** Complete each private submit before inspecting state and suppress unrelated next-work dispatch. */
function project(...args) {
  const box = e2e.project(...args);
  const run = box.run;
  box.run = (cwd, ...argv) => {
    if (argv[0] === 'submit') argv.push('--wait', '--no-next');
    if (argv[0] === 'join' && !argv.includes('--model')) argv.push('--model', BUILDER_MODEL);
    if (argv[0] === 'join' && !argv.includes('--route')) argv.push('--route', 'strong');
    if (argv[0] === 'verify') argv.push('--no-next');
    return run(cwd, ...argv);
  };
  return box;
}

/** The model name fixture seats join with. */
const BUILDER_MODEL = 'Fixture builder';

/** Await the production CLI for fixture setup and moves while retaining the real submit worker and gate. */
function fixtureCommand(box, cwd, ...args) {
  if (args[0] === 'submit') args.push('--wait', '--no-next');
  if (args[0] === 'verify') args.push('--no-next');
  if (args[0] === 'join' && !args.includes('--model')) args.push('--model', BUILDER_MODEL);
  if (args[0] === 'join' && !args.includes('--route')) args.push('--route', 'strong');
  return runCliInProcess(args, { cwd, env: box.env });
}

/** Run repeated reopen probes through awaited production parsing and native board dispatch. */
function reopenCommand(box, cwd, ...args) {
  return runCliInProcess(['reopen', ...args], { cwd, env: box.env });
}

/** Open the real board SQLite file created by the CLI fixture and close it with the test. */
function openFixtureBoard(t, box) {
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  return board;
}

/** Add, claim and submit a real item through its joined Git worktree. */
async function submitFixture(box) {
  const added = (await fixtureCommand(box, box.repo, 'add', 'web', 'Corrected criterion', '--specs', 'G1', '--criterion', 'The page renders.', '--route', 'strong'));
  assert.equal(added.code, 0, added.err);
  const claimed = (await fixtureCommand(box, box.web, 'claim', '1'));
  assert.equal(claimed.code, 0, claimed.err);
  const commit = commitFile(box, box.web, 'web/page.html', '<h1>Page</h1>', 'feat(web): page [G1]');
  assert.equal(commit.status, 0, commit.stderr);
  const submitted = (await fixtureCommand(box, box.web, 'submit', '1'));
  assert.equal(submitted.code, 0, submitted.err);
  return { commit: box.git(box.web, 'rev-parse', 'HEAD'), tree: box.git(box.web, 'rev-parse', 'HEAD^{tree}') };
}

/** Reserve the real submission from a separate joined reviewer checkout. */
async function reserveFixtureReview(box) {
  const reviewPath = join(box.dir, 'reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', reviewPath, '-b', 'review/one');
  const joined = (await fixtureCommand(box, reviewPath, 'join', 'api'));
  assert.equal(joined.code, 0, joined.err);
  const reserved = (await fixtureCommand(box, reviewPath, 'next', '--verify', '1'));
  assert.equal(reserved.code, 0, reserved.err);
  return reviewPath;
}

/** Configure a real private main, joined builder, failing landing test and bare origin. */
function landingProject() {
  const box = project('node --test --test-reporter=tap web/landing.test.js');
  // The private landing runs a real nested Node test runner, not the parent's test worker.
  delete box.env.NODE_TEST_CONTEXT;
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web', 'feature.js'), 'export const status = "PASS";\n');
  writeFileSync(join(box.repo, 'web', 'landing.test.js'), [
    "import assert from 'node:assert/strict';",
    "import { readFileSync } from 'node:fs';",
    "import { test } from 'node:test';",
    "test('keeps the landed behavior', () => assert.match(readFileSync(new URL('./feature.js', import.meta.url), 'utf8'), /export const status/u));",
    '',
  ].join('\n'));
  const configPath = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.affectedTests = 'node --test --test-reporter=tap';
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  box.git(box.repo, 'add', 'web/landing.test.js', 'web/feature.js', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'test(web): add landing behavior check');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const remote = join(box.dir, 'origin.git');
  box.git(box.dir, 'init', '-q', '--bare', remote);
  box.git(box.repo, 'remote', 'add', 'origin', remote);
  box.git(box.repo, 'push', '-q', '-u', 'origin', 'main');
  return { ...box, remote };
}

/** Add a real trunk regression after review, so only combining it with the candidate turns red. */
function requireLandingBehavior(box) {
  const file = join(box.repo, 'web', 'landing.test.js');
  const previous = readFileSync(file, 'utf8');
  writeFileSync(file, previous.replace('assert.match', 'assert.doesNotMatch').replace('/export const status/u', '/RED/u'));
  box.git(box.repo, 'add', 'web/landing.test.js');
  box.git(box.repo, 'commit', '-q', '-m', 'test(web): check behavior during integration [G1]');
  box.git(box.repo, 'push', '-q', 'origin', 'main');
}

/** Add and submit an item using its real joined Git worktree and frozen syntax check. */
async function submitLandingFixture(box, number, contents, cwd = box.web) {
  if (cwd !== box.web) {
    box.git(box.repo, 'worktree', 'add', '-q', '-b', `web/landing-${number}`, cwd, 'main');
    assert.match((await fixtureCommand(box, cwd, 'join', 'web')).out, /joined as web-/u);
  }
  const added = (await fixtureCommand(box, box.repo, 'add', 'web', `Landing fixture ${number}`, '--specs', 'G1', '--route', 'strong', '--criterion', `landing fixture ${number} remains valid`,
    '--check', 'node --check web/feature.js', '--json'));
  assert.equal(added.code, 0, added.err);
  const id = JSON.parse(added.out).item.item_id;
  assert.equal((await fixtureCommand(box, cwd, 'claim', String(id))).code, 0);
  const committed = commitFile(box, cwd, 'web/feature.js', contents, `feat(web): submit landing fixture ${number} [G1]`);
  assert.equal(committed.status, 0, committed.stderr);
  const commit = box.git(cwd, 'rev-parse', 'HEAD');
  const submitted = (await fixtureCommand(box, cwd, 'submit', String(id)));
  assert.equal(submitted.code, 0, submitted.err);
  return { id, cwd, commit };
}

/** Accept an item at its actual submitted commit, then restore the coordinator's main checkout. */
async function acceptLandingFixture(box, item) {
  box.git(box.repo, 'switch', '-q', '--detach', item.commit);
  try {
    const result = (await fixtureCommand(box, box.repo, 'verify', String(item.id), 'accept', '--as', 'coordinator', '--note', 'private landing fixture passed its frozen check'));
    assert.equal(result.code, 0, result.err);
  } finally { box.git(box.repo, 'switch', '-q', 'main'); }
}

/** Read a complete public item projection through a short-lived board connection. */
function readItem(box, id) {
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try { return { ...store.getItem(board, id), thread: store.itemThread(board, id), verdicts: store.verdictsFor(board, id) }; }
  finally { store.closeBoard(board); }
}

test('the reopen command prints its versioned result and refuses with JSON codes and exit 1 [V2,V6,O8]', async () => {
  const box = project();
  const submitted = await submitFixture(box);
  await reserveFixtureReview(box);

  const wrongCaller = await reopenCommand(box, box.web, '1', '--note', 'criterion wording needs correction', '--json');
  assert.equal(wrongCaller.code, 1);
  assert.equal(JSON.parse(wrongCaller.out).error.code, 'COORDINATOR_ONLY');
  const missingNote = await reopenCommand(box, box.repo, '1', '--note', ' ', '--json');
  assert.equal(missingNote.code, 1);
  assert.equal(JSON.parse(missingNote.out).error.code, 'NOTE_REQUIRED');


  const reopened = await reopenCommand(box, box.repo, '1', '--note', 'correct the frozen criterion, not the work', '--json');
  assert.equal(reopened.code, 0, reopened.err);
  const result = JSON.parse(reopened.out);
  assert.equal(result.version, 1);
  assert.equal(result.id, 1);
  assert.equal(result.commit, submitted.commit);
  const alreadyOpen = await reopenCommand(box, box.repo, '1', '--note', 'try twice', '--json');
  assert.equal(alreadyOpen.code, 1);
  assert.equal(JSON.parse(alreadyOpen.out).error.code, 'NOT_SUBMITTED');
});

test('clause 2: a red landing gate returns a verified item to its builder [B3,V4]', async () => {
  const box = landingProject();
  const item = await submitLandingFixture(box, 1, 'export const status = "RED";\n');
  await acceptLandingFixture(box, item);
  const initial = readItem(box, item.id);
  const originalAccept = initial.thread.find((event) => event.type === 'move' && event.kind === 'accept');
  assert.ok(originalAccept, 'the item begins with an actual accept event');
  requireLandingBehavior(box);

  const nonCoordinator = await reopenCommand(box, item.cwd, String(item.id), '--note', 'coordinator only', '--json');
  assert.equal(JSON.parse(nonCoordinator.out).error.code, 'COORDINATOR_ONLY');

  const landing = (await fixtureCommand(box, box.repo, 'land', '--max', '1', '--json'));
  // land exits 1 when nothing lands and every candidate is a culprit (d8505b797a).
  assert.equal(landing.code, 1, `${landing.err}\n${landing.out}`);
  const landingResult = JSON.parse(landing.out);
  assert.deepEqual(landingResult.culprits.map((culprit) => culprit.id), [item.id], JSON.stringify(landingResult));
  assert.equal(landingResult.culprits[0].mergeCommit, landingResult.batch.tip);
  assert.equal(landingResult.culprits[0].tests[0].file, 'web/landing.test.js');
  const returned = readItem(box, item.id);
  assert.equal(returned.item_status, 'open', 'land reopens its named culprit automatically');
  const automaticReopen = returned.thread.find((event) => event.type === 'move' && event.kind === 'reopen');
  assert.ok(automaticReopen);
  assert.equal(automaticReopen.detail.supersedes, originalAccept.eventId);
  assert.equal(automaticReopen.detail.landingFailure.mergeCommit, landingResult.batch.tip);
  assert.deepEqual(automaticReopen.detail.landingFailure.tests, landingResult.culprits[0].tests);
  assert.ok(returned.thread.some((event) => event.type === 'move' && event.eventId === originalAccept.eventId && event.kind === 'accept'),
    'the original accept remains in append-only item history');
  assert.deepEqual(returned.thread.find((event) => event.eventId === originalAccept.eventId), originalAccept,
    'returning the item does not rewrite its earlier accept event');
  assert.deepEqual(returned.verdicts, initial.verdicts, 'the prior verdict receipt stays byte-for-byte unchanged');
  const landingNote = automaticReopen.detail.note;

  const firstClaim = (await fixtureCommand(box, item.cwd, 'claim', String(item.id)));
  assert.equal(firstClaim.code, 0, firstClaim.err);
  // A resubmit with no diff against main is EMPTY_SUBMIT before any proof; carry a real change so the red gate decides.
  const stillRed = commitFile(box, item.cwd, 'web/feature.js', 'export const status = "RED"; // unchanged behavior\n', 'fix(web): retry without fixing the landing behavior [G1]');
  assert.equal(stillRed.status, 0, stillRed.stderr);
  const unchangedLandingHead = (await fixtureCommand(box, item.cwd, 'submit', String(item.id), '--json'));
  assert.equal(unchangedLandingHead.code, 1);
  const reclaimedHead = box.git(item.cwd, 'rev-parse', 'HEAD');
  assert.equal(JSON.parse(unchangedLandingHead.out).error.code, reclaimedHead === item.commit ? 'HEAD_NOT_NEW' : 'GATE_RED',
    'the original head is refused before proof; a claim that merged main still fails the unchanged red behavior');
  assert.equal(readItem(box, item.id).item_status, 'claimed', 'neither refusal records another submission');
  assert.equal(box.tryGit(item.cwd, 'merge-base', '--is-ancestor', item.commit, 'HEAD').status, 0,
    'the builder reclaims on top of the accepted commit');
  const firstFix = commitFile(box, item.cwd, 'web/feature.js', 'export const status = "PASS_FIXED";\n', 'fix(web): restore landing behavior [G1]');
  assert.equal(firstFix.status, 0, firstFix.stderr);
  item.commit = box.git(item.cwd, 'rev-parse', 'HEAD');
  const firstSubmit = (await fixtureCommand(box, item.cwd, 'submit', String(item.id)));
  assert.equal(firstSubmit.code, 0, firstSubmit.err);
  const awaitingFreshAccept = readItem(box, item.id);
  assert.equal(awaitingFreshAccept.item_status, 'submitted');
  assert.equal(awaitingFreshAccept.item_verified_by, null, 'the older accept does not verify the resubmission');
  const firstDryLand = (await fixtureCommand(box, box.repo, 'land', '--dry-run', '--json'));
  assert.equal(firstDryLand.code, 0, firstDryLand.err);
  assert.ok(!JSON.parse(firstDryLand.out).items.includes(item.id), 'the earlier accept cannot make the resubmission eligible to land');
  await acceptLandingFixture(box, item);
  const firstResubmission = readItem(box, item.id);
  const firstFreshAccept = firstResubmission.thread.filter((event) => event.type === 'move' && event.kind === 'accept').at(-1);
  assert.notEqual(firstFreshAccept.detail.commit, originalAccept.detail.commit);

  const nextManualNote = `web/landing.test.js: keeps the landed behavior; merge commit ${'e'.repeat(40)}`;
  const returnedAgain = await reopenCommand(box, box.repo, String(item.id), '--note', nextManualNote, '--json');
  assert.equal(returnedAgain.code, 0, returnedAgain.err);
  const returnedAgainItem = readItem(box, item.id);
  const returnedAgainEvent = returnedAgainItem.thread.filter((event) => event.type === 'move' && event.kind === 'reopen').at(-1);
  assert.equal(returnedAgainEvent.detail.supersedes, firstFreshAccept.eventId);
  assert.equal(returnedAgainEvent.detail.landingFailure.batch, null);

  const secondClaim = (await fixtureCommand(box, item.cwd, 'claim', String(item.id)));
  assert.equal(secondClaim.code, 0, secondClaim.err);
  const secondFix = commitFile(box, item.cwd, 'web/feature.js', 'export const status = "PASS_AGAIN";\n', 'fix(web): finish landing rework [G1]');
  assert.equal(secondFix.status, 0, secondFix.stderr);
  item.commit = box.git(item.cwd, 'rev-parse', 'HEAD');
  const secondSubmit = (await fixtureCommand(box, item.cwd, 'submit', String(item.id)));
  assert.equal(secondSubmit.code, 0, secondSubmit.err);
  const secondAwaitingAccept = readItem(box, item.id);
  assert.equal(secondAwaitingAccept.item_status, 'submitted');
  assert.equal(secondAwaitingAccept.item_verified_by, null, 'the prior accepts do not verify the second resubmission');
  const secondDryLand = (await fixtureCommand(box, box.repo, 'land', '--dry-run', '--json'));
  assert.equal(secondDryLand.code, 0, secondDryLand.err);
  assert.ok(!JSON.parse(secondDryLand.out).items.includes(item.id), 'the earlier accepts cannot make the second resubmission eligible to land');
  await acceptLandingFixture(box, item);
  const readyToLand = readItem(box, item.id);
  assert.equal(readyToLand.thread.filter((event) => event.type === 'move' && event.kind === 'accept').length, 3,
    'the resubmitted work has a fresh accept');
  assert.equal(JSON.parse((await fixtureCommand(box, item.cwd, 'reopen', String(item.id), '--note', landingNote, '--json')).out).error.code, 'COORDINATOR_ONLY');

  const greenLanding = (await fixtureCommand(box, box.repo, 'land', '--max', '1', '--json'));
  assert.equal(greenLanding.code, 0, greenLanding.err);
  assert.deepEqual(JSON.parse(greenLanding.out).landed, [item.id]);
  const merged = readItem(box, item.id);
  assert.equal(merged.item_status, 'verified');
  assert.ok(merged.item_merged_commit);
  const mergedReopen = await reopenCommand(box, box.repo, String(item.id), '--note', landingNote, '--json');
  assert.equal(mergedReopen.code, 1);
  assert.equal(JSON.parse(mergedReopen.out).error.code, 'ALREADY_MERGED');
});

test('clause 3: retained main controls builder first refusal during detached review [B13,B5,H16]', async t => {
  const box = project();
  /** Await real production commands; fixture moves do not start an unrelated next-work search. */
  const command = (cwd, ...args) => runCliInProcess(args, { cwd, env: box.env });
  const added = await command(box.repo, 'add', 'web', 'Corrected criterion', '--specs', 'G1', '--criterion', 'The page renders.', '--route', 'strong', '--wait');
  assert.equal(added.code, 0, added.err);
  const claimedFirst = await command(box.web, 'claim', '1');
  assert.equal(claimedFirst.code, 0, claimedFirst.err);
  const built = commitFile(box, box.web, 'web/page.html', '<h1>Page</h1>', 'feat(web): page [G1]');
  assert.equal(built.status, 0, built.stderr);
  const submitted = await command(box.web, 'submit', '1', '--wait', '--no-next');
  assert.equal(submitted.code, 0, submitted.err);
  const commit = box.git(box.web, 'rev-parse', 'HEAD');
  const configPath = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.claim = { reopenFirstRefusalMinutes: 30 };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: enable the private builder window');
  const main = box.git(box.repo, 'rev-parse', 'HEAD');
  assert.equal(JSON.parse(box.git(box.web, 'show', 'HEAD:pullboard.json')).claim, undefined,
    'the candidate does not carry the enabled setting');
  box.git(box.repo, 'switch', '-q', '--detach', commit);
  try {
    const accepted = await command(box.repo, 'verify', '1', 'accept', '--no-next', '--as', 'coordinator', '--note', 'the private frozen check passed');
    assert.equal(accepted.code, 0, accepted.err + accepted.out);
  } finally { box.git(box.repo, 'switch', '-q', 'main'); }
  const withdrawn = await command(box.repo, 'reopen', '1', '--withdraw-verdict', '--note', 'the private proof requires rework', '--json');
  assert.equal(withdrawn.code, 0, withdrawn.err + withdrawn.out);
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD'), main);
  const other = join(box.dir, 'web-other');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', other, 'main');
  assert.equal((await command(other, 'join', 'web', '--model', 'Other private builder', '--route', 'strong')).code, 0);
  const refused = await command(other, 'claim', '1', '--json');
  assert.equal(refused.code, 1, refused.out);
  const error = JSON.parse(refused.out).error;
  assert.equal(error.code, 'REOPEN_HELD_FOR_BUILDER');
  assert.match(error.message, /web-1/u);
  const board = openFixtureBoard(t, box);
  const returned = store.events(board, { itemId: 1 }).findLast(event => event.event_kind === 'reopen');
  const window = JSON.parse(returned.event_detail).reopenFirstRefusal;
  assert.equal(window.builder, 'web-1');
  assert.equal(Date.parse(window.until) - Date.parse(returned.event_at), 30 * 60_000);
  assert.equal(store.recentShouts(board).filter(row => row.shout_to === 'web-1' && row.shout_text.includes('waits for you')).length, 1);
  // #2779 removed the first-refusal window a reject sealed; this clause covers the withdrawal path (#2460), where the claim opens only once the window has passed.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(29 * 60_000);
  // #3447: a builder silent for two minutes is gone and its window ends at once, so the live builder beats before each claim.
  store.heartbeatSeat(board, 'web-1');
  const insideWindow = await command(other, 'claim', '1', '--json');
  assert.equal(insideWindow.code, 1, insideWindow.out);
  assert.equal(JSON.parse(insideWindow.out).error.code, 'REOPEN_HELD_FOR_BUILDER', 'still inside the 30-minute window');
  t.mock.timers.tick(2 * 60_000);
  store.heartbeatSeat(board, 'web-1');
  const claimed = await command(other, 'claim', '1');
  assert.equal(claimed.code, 0, claimed.err);
});
