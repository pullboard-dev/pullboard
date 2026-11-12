/** Real Git and SQLite coverage for an accepted item that conflicts with the trunk [B3,D1]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { moveArgs } from '../../../../packages/person/index.js';
import {
  applyRelayMove,
  prepareEngineMove,
} from '../../../../packages/state/index.js';
import {
  exportBoard,
  importBoard,
} from '../../../../packages/store/index.js';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import { CONFLICT_ENGINE } from '../../../../packages/state/light.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

// The worktree join in project() inherits PULLBOARD_MODEL; without it the join refuses with MODEL_REQUIRED
// and the fixture fails before any case runs, so the file declares a model for its own sandboxes.
process.env.PULLBOARD_MODEL ??= 'Test Model';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { project, commitFile } = e2e;

/** Real Git paths with a space and a comma; each conflict names them exactly as Git does. */
const ODD_FILES = ['web/my feature.js', 'web/a,b.js'];
const ALL_FILES = ['web/feature.js', ...ODD_FILES];

/** Read an item, its thread and its verdicts through a short-lived board connection. */
function readItem(box, id) {
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try { return { ...store.getItem(board, id), thread: store.itemThread(board, id), verdicts: store.verdictsFor(board, id) }; }
  finally { store.closeBoard(board); }
}

/** Return the refusal code of a JSON run, failing with its output when it did not refuse. */
function refusal(result) {
  assert.equal(result.code, 1, [result.out, result.err].join('\n'));
  return JSON.parse(result.out).error.code;
}

/** Add, claim, build and submit one web item from the joined builder worktree. */
async function submitItem(box, title, contents) {
  const added = (await fixtureAdd(box.runLocal, box.repo, 'web', title, '--specs', 'G1', '--criterion', `${title} stays valid`, '--check', 'node --check web/feature.js', '--json'));
  assert.equal(added.code, 0, added.err);
  const id = JSON.parse(added.out).item.item_id;
  assert.equal((await box.runLocal(box.web, 'claim', String(id))).code, 0);
  mkdirSync(join(box.web, 'web'), { recursive: true });
  for (const file of ODD_FILES) writeFileSync(join(box.web, file), contents);
  const committed = commitFile(box, box.web, 'web/feature.js', contents, `feat(web): ${title.toLowerCase()} [G1]`);
  assert.equal(committed.status, 0, committed.stderr);
  const submitted = (await box.runLocal(box.web, 'submit', String(id)));
  assert.equal(submitted.code, 0, submitted.err);
  return { id, commit: box.git(box.web, 'rev-parse', 'HEAD') };
}

/** Accept an item as the coordinator at its submitted commit, then return the main checkout to main. */
async function accept(box, id, commit) {
  box.git(box.repo, 'switch', '-q', '--detach', commit);
  try {
    const result = (await box.runLocal(box.repo, 'verify', String(id), 'accept', '--as', 'coordinator', '--note', 'ran the frozen check at the submitted commit'));
    assert.equal(result.code, 0, result.err);
  } finally { box.git(box.repo, 'switch', '-q', 'main'); }
}

/** Move the trunk under an accepted item: main changes the same line of web/feature.js. */
function moveTrunk(box) {
  for (const file of ODD_FILES) { mkdirSync(join(box.repo, 'web'), { recursive: true }); writeFileSync(join(box.repo, file), 'export const status = "TRUNK";\n'); }
  const committed = commitFile(box, box.repo, 'web/feature.js', 'export const status = "TRUNK";\n', 'feat(web): trunk changes the status [G1]');
  assert.equal(committed.status, 0, committed.stderr);
  return box.git(box.repo, 'rev-parse', 'HEAD');
}

test('a conflicting accepted item reopens for a main merge [B3,D1]', async () => {
  const box = project();
  const clean = (await submitItem(box, 'Clean item', 'export const status = "CLEAN";\n'));
  (await accept(box, clean.id, clean.commit));
  const cleanReopen = (await box.runLocal(box.repo, 'reopen', String(clean.id), '--conflict', 'web/feature.js', '--json'));
  assert.equal(refusal(cleanReopen), 'NOT_CONFLICTING', 'accepted work that merges cleanly cannot be reopened as a conflict');
  assert.match(JSON.parse(cleanReopen.out).error.next, /merge it/u);
  assert.equal(readItem(box, clean.id).item_status, 'verified');
  assert.equal(box.tryGit(box.repo, 'merge', '-q', '--no-edit', clean.commit).status, 0);
  assert.equal((await box.runLocal(box.repo, 'merged', String(clean.id), box.git(box.repo, 'rev-parse', 'HEAD'))).code, 0);

  const item = (await submitItem(box, 'Conflicting item', 'export const status = "ITEM";\n'));
  const submittedConflict = (await box.runLocal(box.repo, 'reopen', String(item.id), '--conflict', 'web/feature.js', '--json'));
  assert.equal(refusal(submittedConflict), 'NOT_ACCEPTED', 'a submission is not accepted work; it reopens with --note');
  (await accept(box, item.id, item.commit));
  const frozen = readItem(box, item.id).item_frozen_digest;
  const trunk = moveTrunk(box);

  assert.equal(refusal((await box.runLocal(box.web, 'reopen', String(item.id), '--conflict', 'web/feature.js', '--json'))), 'COORDINATOR_ONLY', 'an agent cannot reopen');
  assert.equal(refusal((await box.runLocal(box.repo, 'reopen', String(item.id), '--json'))), 'NOTE_REQUIRED');
  assert.equal(refusal((await box.runLocal(box.repo, 'reopen', String(item.id), '--note', 'conflicts with main', '--json'))), 'LANDING_FAILURE_REQUIRED',
    'a verified item without --conflict or a landing failure note is still refused');
  const wrongFile = (await box.runLocal(box.repo, 'reopen', String(item.id), '--conflict', 'web/feature.js', '--conflict', 'web/other.js', '--json'));
  assert.equal(refusal(wrongFile), 'CONFLICT_FILES', 'every named file must be one Git reports as conflicting');
  assert.match(JSON.parse(wrongFile.out).error.message, /web\/other\.js does not conflict/u);
  assert.equal(refusal((await box.runLocal(box.repo, 'reopen', String(item.id), '--conflict', '', '--json'))), 'CONFLICT_FILES', 'an empty name names nothing');
  assert.equal(readItem(box, item.id).item_status, 'verified', 'no refusal changed the item');

  const joined = (await box.runLocal(box.repo, 'reopen', String(item.id), '--conflict', 'web/my feature.js, web/a,b.js', '--json'));
  assert.equal(refusal(joined), 'CONFLICT_FILES', 'one value is one exact path; nothing inside it is split');
  assert.match(JSON.parse(joined.out).error.message, /^"web\/my feature\.js, web\/a,b\.js" does not conflict/u);
  assert.equal(refusal((await box.runLocal(box.repo, 'reopen', String(item.id), '--conflict', ' web/feature.js', '--json'))), 'CONFLICT_FILES', 'nothing is trimmed');
  assert.deepEqual(moveArgs({ verb: 'reopen', item: item.id, args: { conflict: ODD_FILES } }),
    ['reopen', String(item.id), '--conflict=web/my feature.js', '--conflict=web/a,b.js', '--json', '--'], 'the API passes each path as its own flag');
  const reopened = (await box.runLocal(box.repo, 'reopen', String(item.id), ...ALL_FILES.flatMap((file) => ['--conflict', file]), '--json'));
  assert.equal(reopened.code, 0, [reopened.out, reopened.err].join('\n'));
  const receipt = JSON.parse(reopened.out);
  assert.deepEqual(receipt.conflict, { files: ALL_FILES, trunk }, 'the receipt names the conflicting files exactly and the trunk commit');
  assert.equal(receipt.landingFailure, undefined, 'a trunk conflict is never a landing test failure');
  const returned = readItem(box, item.id);
  assert.equal(returned.item_status, 'open');
  assert.equal(returned.item_commit, item.commit, 'the accepted commit stays recorded');
  const acceptEvent = returned.thread.findLast((entry) => entry.type === 'move' && entry.kind === 'accept');
  const reopenEvent = returned.thread.findLast((entry) => entry.type === 'move' && entry.kind === 'reopen');
  assert.equal(reopenEvent.detail.supersedes, acceptEvent.eventId, 'the reopen names the accept it sets aside');
  assert.deepEqual(reopenEvent.detail.conflict, { files: ALL_FILES, trunk });
  assert.equal(reopenEvent.detail.landingFailure, undefined);
  assert.match(reopenEvent.detail.note, /conflicts with the trunk at [a-f0-9]{12} in web\/feature\.js/u);
  assert.deepEqual(returned.verdicts.map((verdict) => verdict.verdict_decision), ['ACCEPT'], 'no reject is recorded; the accept stands');

  const shown = (await box.runLocal(box.repo, 'show', String(item.id)));
  assert.match(shown.out, new RegExp(`^#${item.id}  open \\(needs main merge\\)  web`, 'mu'), 'the item reads as needing a main merge, not rejected');
  assert.doesNotMatch(shown.out, /\(rejected\)/u);
  assert.match(shown.out, new RegExp(`needs main merge: accepted by coordinator \\(unknown\\) at ${item.commit.slice(0, 12)}; conflicts with the trunk at ${trunk.slice(0, 12)} in web/feature\\.js, "web/my feature\\.js", "web/a,b\\.js"`, 'u'));
  assert.match(shown.out, new RegExp(`next: pullboard claim ${item.id} \\(the bar is unchanged\\), merge main`, 'u'));
  assert.match((await box.runLocal(box.repo, 'list', 'web')).out, new RegExp(`#${item.id}  open \\(needs main merge\\)`, 'u'));
  const resume = (await box.runLocal(box.web, 'resume', '--json'));
  assert.equal(resume.code, 0, resume.err);
  assert.deepEqual(JSON.parse(resume.out).mainMerges.map((entry) => entry.item.item_id), [item.id], 'the builder sees its item needs a main merge');
  assert.match((await box.runLocal(box.web, 'resume')).out, new RegExp(`needs main merge: accepted by .*; next: pullboard claim ${item.id} \\(the bar is unchanged\\), merge main`, 'u'));

  assert.equal((await box.runLocal(box.web, 'claim', String(item.id))).code, 0);
  assert.equal(readItem(box, item.id).item_frozen_digest, frozen, 'the builder claims it with its bar unchanged');
  const merged = box.tryGit(box.web, 'merge', '-q', '--no-edit', 'main');
  assert.notEqual(merged.status, 0, 'merging main conflicts in the named file');
  const resolved = commitFile(box, box.web, 'web/feature.js', 'export const status = "ITEM";\n', 'fix(web): merge main into the item [G1]');
  assert.equal(resolved.status, 0, resolved.stderr);
  const head = box.git(box.web, 'rev-parse', 'HEAD');
  const resubmitted = (await box.runLocal(box.web, 'submit', String(item.id)));
  assert.equal(resubmitted.code, 0, resubmitted.err);
  const review = (await box.runLocal(box.repo, 'show', String(item.id)));
  assert.match(review.out, new RegExp(`re-review: main merge only; run the frozen check at ${head.slice(0, 12)}`, 'u'), 'the re-review is the frozen check at the new head');
  (await accept(box, item.id, head));
  assert.doesNotMatch((await box.runLocal(box.repo, 'show', String(item.id))).out, /needs main merge/u, 'the new accept clears the label');
});

test('a trunk conflict is not counted as a test cause [D1,B3]', async () => {
  const box = project();
  const red = (await submitItem(box, 'Red landing item', 'export const status = "RED";\n'));
  (await accept(box, red.id, red.commit));
  const landing = (await box.runLocal(box.repo, 'reopen', String(red.id), '--note', `web/landing.test.js: keeps the landed behavior; merge commit ${'c'.repeat(40)}`, '--json'));
  assert.equal(landing.code, 0, landing.out);
  box.git(box.web, 'reset', '-q', '--hard', 'main');
  const item = (await submitItem(box, 'Conflict item', 'export const status = "ITEM";\n'));
  (await accept(box, item.id, item.commit));
  const trunk = moveTrunk(box);
  const reopened = (await box.runLocal(box.repo, 'reopen', String(item.id), ...ALL_FILES.flatMap((file) => ['--conflict', file]), '--note', 'two accepted items changed web/feature.js'));
  assert.equal(reopened.code, 0, reopened.err);
  assert.match(reopened.out, /for a main merge: conflicts with the trunk at [a-f0-9]{12} in web\/feature\.js, "web\/my feature\.js", "web\/a,b\.js"; the accept at/u, 'each name reads as one name');

  const reopenOf = (id) => readItem(box, id).thread.findLast((entry) => entry.type === 'move' && entry.kind === 'reopen').detail;
  assert.deepEqual(reopenOf(red.id).landingFailure.tests, [{ file: 'web/landing.test.js', name: 'keeps the landed behavior' }], 'a red landing names its failing test');
  assert.equal(reopenOf(red.id).cause, 'test:web/landing.test.js::keeps the landed behavior', 'a red landing derives the cause of its failing test (engine 102)');
  const conflict = reopenOf(item.id);
  assert.equal(conflict.landingFailure, undefined, 'a trunk conflict names no failing test');
  assert.equal(conflict.cause, `conflict:${ALL_FILES[0]}`, 'its cause key is the conflict kind (engine 102), never a test: key');
  assert.ok(conflict.cause.startsWith('conflict:') && !conflict.cause.startsWith('test:'), 'a merge conflict is not a test cause');
  assert.equal(conflict.causeDerivation.kind, 'merge-conflict', 'it names the merge conflict as its derivation');
  assert.deepEqual(conflict.conflict, { files: ALL_FILES, trunk });
  assert.equal(conflict.note, 'two accepted items changed web/feature.js', 'a note the coordinator gives is kept');
  assert.ok(!Object.keys(conflict).some((key) => /test/iu.test(key)), 'no field records a test');
  assert.deepEqual(readItem(box, item.id).verdicts.map((verdict) => verdict.verdict_reason), ['CRITERION_MET'], 'no TEST_FAILURE verdict is recorded');
});

test('an older engine refuses a trunk conflict reopen before changing anything [B3,H16]', async (t) => {
  const box = project();
  const item = (await submitItem(box, 'Engine item', 'export const status = "ITEM";\n'));
  (await accept(box, item.id, item.commit));
  const trunk = moveTrunk(box);
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-conflict-engine-'));
  const source = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  const snapshot = exportBoard(source);
  store.closeBoard(source);
  const replica = openBoard(join(directory, 'replica.sqlite'));
  t.after(() => { store.closeBoard(replica); rmSync(directory, { recursive: true, force: true }); });
  importBoard(replica, snapshot);
  assert.ok(ENGINE_VERSION >= CONFLICT_ENGINE);
  const args = [item.id, { agentId: 'coordinator', note: '', conflict: { files: ['web/feature.js'], trunk } }];
  const receipt = { sequence: 1, at: '2026-10-17T12:00:00.000Z', kind: 'move', sender: { kind: 'agent', userId: 'fixture-user', agent: 'coordinator' } };
  const before = exportBoard(replica);
  assert.throws(() => applyRelayMove(replica, { version: 1, engine: CONFLICT_ENGINE - 1, id: 'old-conflict', operation: 'reopen', args, actor: 'coordinator' }, receipt),
    (error) => error.code === 'RELAY_MOVE' && error.message.includes(`introduced in engine ${CONFLICT_ENGINE}`));
  assert.deepEqual(exportBoard(replica), before, 'an older engine move carrying a conflict changes nothing');
  replica.executionEngineVersion = CONFLICT_ENGINE - 1;
  assert.throws(() => store.reopen(replica, item.id, args[1]), (error) => error.code === 'ENGINE_VERSION', 'a board replaying an older engine refuses the conflict');
  delete replica.executionEngineVersion;
  assert.deepEqual(exportBoard(replica), before);
  const move = prepareEngineMove(replica, 'reopen', args, { id: 'current-conflict', actor: 'coordinator' });
  assert.equal(move.engine, ENGINE_VERSION);
  const applied = applyRelayMove(replica, move, receipt);
  assert.equal(applied.error, undefined, JSON.stringify(applied));
  assert.deepEqual(applied.result.conflict, { files: ['web/feature.js'], trunk });
  assert.equal(store.getItem(replica, item.id).item_status, 'open');
});
