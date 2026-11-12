/** Board-only commands must stay responsive without weakening checkout ownership [V4,C7]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

/** Read only the board rows relevant to proving that a refused write made no change. */
function boardState(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      item: db.prepare('SELECT item_id, item_status FROM item ORDER BY item_id').all(),
      shout: db.prepare('SELECT shout_id, shout_text FROM shout ORDER BY shout_id').all(),
      fact: db.prepare("SELECT event_id, event_detail FROM event WHERE event_kind = 'fact' ORDER BY event_id").all(),
      event: db.prepare('SELECT event_id, event_kind, event_detail FROM event ORDER BY event_id').all(),
    };
  } finally { db.close(); }
}

/** Wait for one durable fixture observation rather than relying on a scheduling delay. */
async function waitFor(predicate, description, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`timed out waiting for ${description}`);
}

/** Require a responsive command to finish within its explicit board-only latency budget. */
async function within(promise, timeoutMs, description) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${description} did not finish within ${timeoutMs}ms`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

/** Set the explicit fixture session only for the synchronous child spawn. */
function launchAs(box, cwd, command, args, session) {
  box.env.CODEX_SESSION_ID = session;
  try { return helpers.launch(box, cwd, command, args); }
  finally { delete box.env.CODEX_SESSION_ID; }
}

test('a seat can shout while its own submit runs [V4,C7]', { timeout: 45_000 }, async () => {
  const box = helpers.sandbox();
  const gate = helpers.holdingGate(box);
  const project = helpers.project(gate.command, box);
  const markers = [
    'PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL',
    'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD',
  ];
  for (const marker of markers) delete project.env[marker];
  assert.equal(project.run(project.repo, 'settings', 'gateSlots', '1').code, 0);
  assert.equal(fixtureAdd(project.run, project.repo, 'web', 'Held submit', '--specs', 'G1').code, 0);
  const owner = 'checkout-owner-598';
  const intruder = 'checkout-intruder-598';
  const children = [];
  const claim = launchAs(project, project.web, process.execPath, [helpers.BIN, 'claim', '1'], owner);
  children.push(claim);
  const claimResult = await claim.closed;
  assert.equal(claimResult.code, 0, claim.failure ?? claim.stderrText);
  assert.equal(helpers.commitFile(project, project.web, 'web/page.html', 'page', 'feat(web): held submit [G1]').status, 0);
  const expectedHead = project.git(project.web, 'rev-parse', 'HEAD');
  const database = join(project.repo, '.git', 'pullboard', 'board.sqlite');
  const bindingFile = resolve(project.web, project.git(project.web, 'rev-parse', '--git-dir'), 'pullboard-checkout-session.json');
  const originalBinding = readFileSync(bindingFile, 'utf8');
  writeFileSync(gate.mode, 'armed');
  let submit;
  let missingBindingSession;
  let wrongSession;
  let takeover;
  try {
    submit = launchAs(project, project.web, process.execPath, [helpers.BIN, 'submit', '1'], owner);
    children.push(submit);
    await waitFor(() => helpers.gateEvents(gate).includes('start'), 'submit to enter its held gate');
    assert.equal(submit.exitCode, null, 'submit remains active inside the gate');

    const beforeBoardOnly = boardState(database);
    const shout = launchAs(project, project.web, process.execPath, [helpers.BIN, 'shout', 'all', 'still responsive during submit'], owner);
    children.push(shout);
    const shoutResult = await within(shout.closed, 5_000, 'same-session shout');
    assert.equal(shoutResult.code, 0, shout.failure ?? shout.stderrText);
    const fact = launchAs(project, project.web, process.execPath, [helpers.BIN, 'fact', '1', 'note', 'the held submit remains active'], owner);
    children.push(fact);
    const factResult = await within(fact.closed, 5_000, 'same-session fact');
    assert.equal(factResult.code, 0, fact.failure ?? fact.stderrText);
    const read = launchAs(project, project.web, process.execPath, [helpers.BIN, 'show', '1'], owner);
    children.push(read);
    const readResult = await within(read.closed, 5_000, 'same-session read');
    assert.equal(readResult.code, 0, read.failure ?? read.stderrText);
    assert.deepEqual(helpers.gateEvents(gate), ['start'], 'board-only commands do not release or restart the held gate');
    assert.equal(submit.exitCode, null);
    const afterBoardOnly = boardState(database);
    assert.deepEqual(afterBoardOnly.item, beforeBoardOnly.item);
    assert.equal(afterBoardOnly.shout.length, beforeBoardOnly.shout.length + 1);
    assert.match(afterBoardOnly.shout.at(-1).shout_text, /still responsive during submit/u);
    assert.equal(afterBoardOnly.fact.length, beforeBoardOnly.fact.length + 1);
    assert.match(afterBoardOnly.fact.at(-1).event_detail, /held submit remains active/u);
    assert.equal(afterBoardOnly.event.length, beforeBoardOnly.event.length + 2);

    const currentBinding = readFileSync(bindingFile, 'utf8');
    writeFileSync(bindingFile, '{ damaged binding\n');
    const corrupt = launchAs(project, project.web, process.execPath, [helpers.BIN, 'shout', 'all', 'corrupt binding must fail closed', '--json'], owner);
    children.push(corrupt);
    const corruptResult = await within(corrupt.closed, 5_000, 'corrupt-binding refusal');
    assert.equal(corruptResult.code, 1);
    assert.equal(JSON.parse(corrupt.stdoutText).error.code, 'CHECKOUT_SESSION');
    writeFileSync(bindingFile, currentBinding);
    assert.deepEqual(boardState(database), afterBoardOnly, 'a corrupt binding cannot use the board-only path');

    // A missing binding takes the lease only to rebind this same session, then writes beside the running submit.
    rmSync(bindingFile, { force: true });
    missingBindingSession = launchAs(project, project.web, process.execPath,
      [helpers.BIN, 'shout', 'all', 'missing binding rebinds', '--json'], owner);
    children.push(missingBindingSession);
    const missingBindingResult = await within(missingBindingSession.closed, 5_000, 'same-session write with a missing binding');
    assert.equal(missingBindingResult.code, 0, missingBindingSession.failure ?? missingBindingSession.stderrText);
    assert.equal(JSON.parse(readFileSync(bindingFile, 'utf8')).agent, JSON.parse(currentBinding).agent);
    const afterRebind = boardState(database);

    // Another session is refused at once, with no board change, while the submit still runs.
    wrongSession = launchAs(project, project.web, process.execPath, [helpers.BIN, 'shout', 'all', 'wrong session must not write', '--json'], intruder);
    children.push(wrongSession);
    const wrongResult = await within(wrongSession.closed, 5_000, 'wrong-session refusal');
    assert.equal(wrongResult.code, 1);
    assert.equal(JSON.parse(wrongSession.stdoutText).error.code, 'NOT_YOUR_CHECKOUT');
    assert.deepEqual(boardState(database), afterRebind, 'a wrong-session write adds no board rows');

    // A takeover waits for the running submit's writer record, holding the checkout so no new write slips in.
    takeover = launchAs(project, project.web, process.execPath, [helpers.BIN, 'takeover', '--json'], intruder);
    children.push(takeover);
    const intent = resolve(project.web, project.git(project.web, 'rev-parse', '--git-dir'), 'pullboard-checkout-takeover');
    await waitFor(() => existsSync(intent) || takeover.exitCode !== null, 'takeover to wait for the active submit');
    assert.equal(takeover.exitCode, null, 'takeover waits while the submit writes');
    assert.equal(submit.exitCode, null);
    assert.deepEqual(boardState(database), afterRebind, 'takeover adds no board rows before the submit finishes');
    assert.equal(helpers.gateEvents(gate).join(','), 'start');

    writeFileSync(gate.release, 'released');
    const [submitResult, takeoverResult] = await Promise.all([submit.closed, takeover.closed]);
    assert.equal(submitResult.code, 0, submit.failure ?? submit.stderrText);
    assert.match(submit.stdoutText, /submitted #1/u);
    assert.equal(takeoverResult.code, 0, takeover.failure ?? takeover.stderrText);
    assert.equal(existsSync(intent), false, 'takeover removes its intent when it ends');
    assert.equal(project.git(project.web, 'rev-parse', 'HEAD'), expectedHead, 'submit leaves the originally submitted HEAD unchanged');
    assert.equal(project.git(project.repo, 'rev-parse', `refs/pullboard/items/1/${expectedHead.slice(0, 12)}`), expectedHead,
      'the submit receipt pins exactly the original HEAD');
    assert.equal(boardState(database).item[0].item_status, 'submitted');
    assert.deepEqual(helpers.gateEvents(gate), ['start', 'end']);

    const beforeOldOwner = boardState(database);
    const oldOwner = launchAs(project, project.web, process.execPath,
      [helpers.BIN, 'shout', 'all', 'old owner cannot write after takeover', '--json'], owner);
    children.push(oldOwner);
    const oldOwnerResult = await oldOwner.closed;
    assert.equal(oldOwnerResult.code, 1);
    assert.equal(JSON.parse(oldOwner.stdoutText).error.code, 'NOT_YOUR_CHECKOUT');
    assert.deepEqual(boardState(database), beforeOldOwner, 'takeover leaves the previous session unable to append a shout');
  } finally {
    writeFileSync(bindingFile, originalBinding);
    writeFileSync(gate.release, 'released');
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
    if (submit?.exitCode === null) submit.kill('SIGTERM');
    await Promise.all([...children, ...(submit ? [submit] : [])].map((child) => child.closed));
  }
});
