/** The ship command retains real hooks, native gates, verdict delivery and first-refusal ownership [V4,B3,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { chmodSync } from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';
import { openBoard } from '../../../lib/index.js';
import * as nativeBoard from '../../../lib/index.js';
import * as store from '../../../../packages/store/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runFixtureChildAsync } from '../../tests/fixtures/child.js';
import { cleanupFixtureChildren } from '../../tests/fixtures/child.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { context } from '../../index.js';
import { withBoardRead } from '../../index.js';
import { retrySync } from '../../index.js';
import { waitForSubmissionVerdict } from '../../../../packages/items/index.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';

/** Read or mutate only this private fixture's actual CLI board, closing before a child runs. */
function onBoard(box, work) {
  // @pullboard-board-file journey: observe public ship and record its independent fixture verdict on the same private board.
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try { return work(board); } finally { store.closeBoard(board); }
}

/** Produce one genuinely claimed web checkout with ordinary hooks enabled. */
async function fixture(t, check = 'true', acceptedFiles = {}) {
  const helpers = createE2eHelpers();
  const children = [];
  t.after(async () => {
    await cleanupFixtureChildren();
    await Promise.all(children);
    helpers.cleanup();
  });
  const box = helpers.project('true');
  // A public CLI subprocess is not a Node test worker; retain NODE_OPTIONS unchanged.
  delete box.env.NODE_TEST_CONTEXT;
  assert.equal(box.env.NODE_TEST_CONTEXT, undefined);
  assert.equal(box.env.NODE_OPTIONS, process.env.NODE_OPTIONS);
  for (const [file, body] of Object.entries(acceptedFiles)) {
    const result = helpers.commitFile(box, box.repo, file, body, 'test(web): accepted green fixture [G1]');
    assert.equal(result.status, 0, result.stderr);
  }
  if (Object.keys(acceptedFiles).length) box.git(box.web, 'merge', '--no-edit', 'main');
  const added = (await fixtureAdd(box.runLocal, box.repo, 'web', 'Ship the staged fixture', '--specs', 'G1',
    '--criterion', 'The fixture passes its native check.', '--check', check, '--json'));
  assert.equal(added.code, 0, added.out + added.err);
  const id = JSON.parse(added.out).item.item_id;
  const claimed = (await box.runLocal(box.web, 'claim', String(id), '--json'));
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  return { helpers, box, id, children };
}

/** Stage exactly the requested fixture bytes; the product must perform the actual commit. */
function stage(box, file, body) {
  mkdirSync(join(box.web, file, '..'), { recursive: true });
  writeFileSync(join(box.web, file), body);
  box.git(box.web, 'add', file);
}

test('ship review wait names its deadline without undoing the completed gate [V4,B3]', async t => {
  const { box, id } = (await fixture(t));
  const changed = createE2eHelpers().commitFile(box, box.web, 'web/deadline.txt', 'Completed gate.\n',
    'feat(web): deadline fixture [G1]');
  assert.equal(changed.status, 0, changed.stderr);
  const submitted = (await box.runLocal(box.web, 'submit', String(id), '--no-next', '--json'));
  assert.equal(submitted.code, 0, submitted.out + submitted.err);
  const value = JSON.parse(submitted.out);
  const receipt = onBoard(box, board => store.events(board, { itemId: id }).findLast(row => row.event_kind === 'submit'));
  const lines = [];
  const io = { cwd: box.web, nativeBoard, nativeBoardPorts: nativeBoard.nativeBoardPorts, say: line => lines.push(line), err: line => lines.push(line), result: () => {} };
  await assert.rejects(waitForSubmissionVerdict(context(io), id, value, receipt,
    { withBoardRead, retrySync, events: store.events, verdictsFor: store.verdictsFor, getItem: store.getItem },
    { deadlineMs: 0 }), { code: 'SUBMISSION_WAIT_TIMEOUT' });
  assert.ok(lines.some(line => line.includes(`waiting for the verdict on #${id}`) && line.includes(' until ')));
  assert.equal(onBoard(box, board => store.getItem(board, id).item_status), 'submitted');
  assert.equal(onBoard(box, board => store.verdictsFor(board, id).length), 0, 'expiry creates no review verdict');
});

/** Real ship runs a hook-checked commit, a main merge and the gate: 8-20 s measured on an idle seat, so the 8 s default raced it [V4,B3,C7]. */
const SHIP_WAIT_MS = 60_000;

/** A fixture reviewer releases the actual --wait only after observing its durable submit. */
async function shipAndAccept(t, f, note = 'The staged fixture shipped.') {
  const { box, helpers, id } = f;
  // Process-level case: ship blocks on the verdict while this test records it on the same board, so it stays a real child.
  const pending = runFixtureChildAsync(process.execPath, [helpers.BIN, 'ship', '--note', note, '--json'], { cwd: box.web, env: box.env });
  const child = pending.child;
  f.children.push(pending);
  let observedOut = '', observedErr = '';
  child.stdout?.on('data', chunk => { observedOut += chunk; });
  child.stderr?.on('data', chunk => { observedErr += chunk; });
  try {
    await helpers.waitFor(() => child.exitCode !== null || onBoard(box, board => store.getItem(board, id).item_status === 'submitted'), 'a ship submission or actionable refusal', SHIP_WAIT_MS); // budget: measured 8-20 s per real ship run, ceiling 60 s
  } catch (error) {
    t.diagnostic(JSON.stringify({ phase: 'await-submit', exitCode: child.exitCode,
      status: onBoard(box, board => store.getItem(board, id).item_status), stdout: observedOut, stderr: observedErr }));
    throw error;
  }
  assert.equal(onBoard(box, board => store.getItem(board, id).item_status), 'submitted', 'ship must reach its actual submit event before verdict delivery');
  assert.equal(child.exitCode, null, 'ship waits for the actual verdict');
  onBoard(box, board => {
    const item = store.getItem(board, id);
    store.verify(board, id, { agentId: 'coordinator', decision: 'ACCEPT', digest: item.item_frozen_digest,
      head: item.item_commit, reason: 'CRITERION_MET', note: 'Independent fixture reviewer accepts the real submission.', policy: 'any', check: 'green' });
  });
  await helpers.waitFor(() => child.exitCode !== null, 'the accepted verdict to finish ship', SHIP_WAIT_MS); // budget: measured 8-20 s per real ship run, ceiling 60 s
  const completed = await pending;
  assert.equal(completed.status, 0, completed.context);
  const document = JSON.parse(completed.stdout);
  assert.equal(document.id, id);
  assert.ok(document.commit && document.pin && document.gate, 'note recording preserves the exact submission JSON');
  assert.equal(document.verdict.verdict_decision, 'ACCEPT');
  const notes = onBoard(box, board => store.events(board, { itemId: id }).filter(row => row.event_kind === 'fact').map(row => JSON.parse(row.event_detail))).filter(row => row.fact_text === note || row.text === note);
  assert.equal(notes.length, 1, 'the requested note is recorded exactly once');
  return document;
}

test('ship commits staged work, merges current main, waits and preserves submission JSON beside its note [V4,B3,C7]', async t => {
  const f = (await fixture(t));
  const before = f.box.git(f.box.web, 'rev-parse', 'HEAD');
  const main = f.helpers.commitFile(f.box, f.box.repo, 'main-note.txt', 'Accepted main advanced.\n', 'chore: advance the private fixture main');
  assert.equal(main.status, 0, main.stderr);
  stage(f.box, 'web/shipped.txt', 'Staged work.\n');
  const result = await shipAndAccept(t, f);
  assert.notEqual(result.commit, before);
  assert.equal(readFileSync(join(f.box.web, 'main-note.txt'), 'utf8'), 'Accepted main advanced.\n');
  assert.equal(f.box.git(f.box.web, 'status', '--porcelain'), '');
  const message = f.box.git(f.box.web, 'log', '--no-merges', '-1', '--format=%B');
  assert.match(message, /Pullboard-Item: #1/u);
  assert.match(message, /Pullboard-Rows: G1/u);
});

test('ship stops at the real failing frozen case without a submit or note [V4,B3]', async t => {
  const green = "import {test} from 'node:test';\nimport assert from 'node:assert/strict';\ntest('ship names this actual failure',()=>assert.equal(1,1));\n";
  const f = (await fixture(t, 'node --test web/broken.test.js', { 'web/broken.test.js': green }));
  // Process-level case: a plain node --test control run on main, not a CLI call.
  const baseline = runFixtureChild(process.execPath, ['--test', 'web/broken.test.js'], { cwd: f.box.repo, env: f.box.env, encoding: 'utf8' });
  assert.equal(baseline.status, 0, baseline.context);
  assert.match(baseline.stdout, /pass 1/u, 'the identical named case is genuinely green on main');
  stage(f.box, 'web/broken.test.js', green.replace('assert.equal(1,1)', 'assert.equal(1,2)'));
  const before = f.box.git(f.box.web, 'rev-parse', 'HEAD');
  const result = await runCliInProcess(['ship', '--note', 'Must not be recorded.', '--json'], { cwd: f.box.web, env: f.box.env });
  const observed = onBoard(f.box, board => ({ item: store.getItem(board, f.id), submissions: store.events(board, { itemId: f.id }).filter(row => row.event_kind === 'submit') }));
  assert.equal(observed.item.item_status, 'claimed', JSON.stringify({ observed, stderr: result.stderr, stdout: result.stdout }));
  assert.equal(result.status, 1, result.stderr + result.stdout);
  const response = JSON.parse(result.stdout);
  assert.equal(response.error.code, 'GATE_RED');
  assert.match(response.error.message, /ship names this actual failure/u);
  assert.ok(response.error.next, 'the first refusal supplies the next move');
  assert.notEqual(f.box.git(f.box.web, 'rev-parse', 'HEAD'), before, 'the actual normal commit completed before the failing gate');
  assert.equal(observed.submissions.length, 0);
  assert.equal(onBoard(f.box, board => store.events(board, { itemId: f.id }).filter(row => row.event_kind === 'fact').map(row => JSON.parse(row.event_detail))).filter(row => row.text === 'Must not be recorded.').length, 0);
});

test('ship never bypasses a commit hook or consumes its staged bytes after refusal [C7,V4]', async t => {
  const f = (await fixture(t));
  stage(f.box, 'web/hook.txt', 'Keep staged.\n');
  const before = f.box.git(f.box.web, 'rev-parse', 'HEAD');
  const hooks = join(f.box.dir, 'refusal-hooks');
  mkdirSync(hooks);
  f.box.git(f.box.web, 'config', 'core.hooksPath', hooks);
  const hook = join(hooks, 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\necho intentional-ship-hook-refusal >&2\nexit 1\n');
  chmodSync(hook, 0o700);
  const hookControl = f.box.tryGit(f.box.web, 'hook', 'run', 'pre-commit');
  assert.equal(hookControl.status, 1, hookControl.context);
  assert.match(hookControl.stderr, /intentional-ship-hook-refusal/u);
  const result = await runCliInProcess(['ship', '--json'], { cwd: f.box.web, env: f.box.env });
  const state = onBoard(f.box, board => store.getItem(board, f.id).item_status);
  assert.equal(state, 'claimed', result.stderr + result.stdout);
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(JSON.parse(result.stdout).error.message, /intentional-ship-hook-refusal/u);
  assert.equal(f.box.git(f.box.web, 'rev-parse', 'HEAD'), before);
  assert.equal(f.box.git(f.box.web, 'diff', '--cached', '--name-only'), 'web/hook.txt');
});

test('ship preserves a real merge conflict and names its next move without submitting [C7,V4]', async t => {
  const f = (await fixture(t, 'true', { 'web/conflict.txt': 'accepted base\n' }));
  const advanced = f.helpers.commitFile(f.box, f.box.repo, 'web/conflict.txt', 'accepted main change\n', 'feat(web): advance conflicting main [G1]');
  assert.equal(advanced.status, 0, advanced.stderr);
  stage(f.box, 'web/conflict.txt', 'staged candidate change\n');
  const result = await runCliInProcess(['ship', '--json'], { cwd: f.box.web, env: f.box.env });
  const state = onBoard(f.box, board => store.getItem(board, f.id).item_status);
  assert.equal(state, 'claimed', result.stderr + result.stdout);
  assert.equal(result.status, 1, result.stderr + result.stdout);
  const response = JSON.parse(result.stdout);
  assert.equal(response.error.code, 'MERGE_CONFLICT');
  assert.match(response.error.next, /resolve/u);
  assert.ok(f.box.git(f.box.web, 'ls-files', '--unmerged'), 'conflicting index stages remain available for resolution');
  assert.match(readFileSync(join(f.box.web, 'web/conflict.txt'), 'utf8'), /staged candidate change/u);
  assert.match(readFileSync(join(f.box.web, 'web/conflict.txt'), 'utf8'), /accepted main change/u);
  assert.equal(onBoard(f.box, board => store.events(board, { itemId: f.id }).filter(row => row.event_kind === 'submit')).length, 0);
});

test('ship leaves unstaged and untracked input untouched before any commit [C7,V4]', async t => {
  const f = (await fixture(t, 'true', { 'web/existing.txt': 'accepted bytes\n' }));
  const before = f.box.git(f.box.web, 'rev-parse', 'HEAD');
  stage(f.box, 'web/staged.txt', 'staged bytes\n');
  writeFileSync(join(f.box.web, 'web/existing.txt'), 'unstaged bytes\n');
  let result = await f.box.runLocal(f.box.web, 'ship', '--json');
  assert.equal(result.code, 1, result.out + result.err);
  assert.equal(JSON.parse(result.out).error.code, 'DIRTY');
  assert.equal(readFileSync(join(f.box.web, 'web/existing.txt'), 'utf8'), 'unstaged bytes\n');
  writeFileSync(join(f.box.web, 'web/existing.txt'), 'accepted bytes\n');
  writeFileSync(join(f.box.web, 'web/untracked.txt'), 'untracked bytes\n');
  result = await f.box.runLocal(f.box.web, 'ship', '--json');
  assert.equal(result.code, 1, result.out + result.err);
  assert.equal(JSON.parse(result.out).error.code, 'UNTRACKED');
  assert.equal(readFileSync(join(f.box.web, 'web/untracked.txt'), 'utf8'), 'untracked bytes\n');
  assert.equal(f.box.git(f.box.web, 'rev-parse', 'HEAD'), before);
  assert.equal(f.box.git(f.box.web, 'diff', '--cached', '--name-only'), 'web/staged.txt');
  assert.equal(onBoard(f.box, board => store.getItem(board, f.id).item_status), 'claimed');
});

/** Expire through the real claim operation, preserving the item's existing immutable frozen bar. */
async function expireClaim(f) {
  onBoard(f.box, board => {
    const item = store.getItem(board, f.id);
    store.claim(board, f.id, { agentId: item.item_owner, lane: 'web', leaseMs: 1,
      head: f.box.git(f.box.web, 'rev-parse', 'HEAD'),
      freeze: () => ({ text: item.item_frozen, digest: item.item_frozen_digest }) });
  });
  await pause(5);
}

test('ship refuses a lapsed claim without first refusal before touching the staged work [B3,V4]', async t => {
  const f = (await fixture(t));
  await expireClaim(f);
  stage(f.box, 'web/lapsed.txt', 'Not yet committed.\n');
  const before = f.box.git(f.box.web, 'rev-parse', 'HEAD');
  const result = await f.box.runLocal(f.box.web, 'ship', String(f.id), '--json');
  assert.equal(result.code, 1, result.out + result.err);
  assert.equal(JSON.parse(result.out).error.code, 'NOT_YOURS');
  assert.equal(f.box.git(f.box.web, 'rev-parse', 'HEAD'), before);
  assert.equal(f.box.git(f.box.web, 'diff', '--cached', '--name-only'), 'web/lapsed.txt');
});

test('ship reclaims a lapsed lease only inside this builder first-refusal window [B3,V4]', async t => {
  const f = (await fixture(t));
  assert.equal(f.helpers.commitFile(f.box, f.box.web, 'web/prior.txt', 'Prior rejected work.\n', 'feat(web): initial fixture [G1]').status, 0);
  const sent = await f.box.runLocal(f.box.web, 'submit', String(f.id), '--no-next', '--json');
  assert.equal(sent.code, 0, sent.out + sent.err);
  onBoard(f.box, board => {
    const item = store.getItem(board, f.id);
    store.verify(board, f.id, { agentId: 'coordinator', decision: 'ACCEPT', digest: item.item_frozen_digest,
      head: item.item_commit, note: 'The fixture passes its native check.', policy: 'any', check: 'green' });
    store.reopen(board, f.id, { agentId: 'coordinator', withdrawVerdict: true,
      note: 'A withdrawn verdict creates the ordinary first-refusal window.', reopenFirstRefusalMinutes: 30 });
  });
  const reclaimed = await f.box.runLocal(f.box.web, 'claim', String(f.id), '--json');
  assert.equal(reclaimed.code, 0, reclaimed.out + reclaimed.err);
  await expireClaim(f);
  stage(f.box, 'web/reworked.txt', 'Actual changed rework.\n');
  await shipAndAccept(t, f);
});
