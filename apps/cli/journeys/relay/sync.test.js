/** @pullboard-test-input apps/lib/index.js apps/lib/src/io/worker/checkpoint/relay.js packages/link/src/io/relay.js packages/outbox/index.js */
/** A relay timeout, a busy link lock or an uncertain baseline never fails a local board move [B26,H16,H17]. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { describe } from 'node:test';
import { test } from 'node:test';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';

const RELAY = JSON.stringify(new URL('../../../../packages/link/src/io/relay.js', import.meta.url).href);
const GUARD = JSON.stringify(new URL('../../../../packages/outbox/index.js', import.meta.url).href);
const CONFLICT = JSON.stringify(new URL('../../../../packages/outbox/index.js', import.meta.url).href);
const BASELINE = JSON.stringify(new URL('../../../../packages/outbox/index.js', import.meta.url).href);
const CHECKPOINT = JSON.stringify(new URL('../../../../packages/outbox/index.js', import.meta.url).href);
const PUBLISH = JSON.stringify(new URL('../../../../packages/outbox/index.js', import.meta.url).href);
const ORDERING = JSON.stringify(new URL('../../../../packages/outbox/index.js', import.meta.url).href);

/** Read the saved link without including ciphertext or credentials in an assertion diagnostic. */
function link(box) { return JSON.parse(readFileSync(box.linkFile, 'utf8')); }

/** Run shout moves in one child process with a short transport timeout, reporting codes, notices and local rows. */
function moves(box, texts, options = {}) {
  return box.script(`
    const { relayOperation, localRecords } = await import(${RELAY});
    const { withOutboxGuard } = await import(${GUARD});
    const { replay: replayConflictRecord } = await import(${CONFLICT});
    const { remoteBoardMissing, uncertainUploadFailure, decideUncertainBaseline } = await import(${BASELINE});
    const { checkpointInBackground, scheduleCheckpoint, requestCheckpointCheck } = await import(${CHECKPOINT});
    const { flushOutbox, queueMove, outboxHasPendingCreatedItem, outboxFields, ACKNOWLEDGED_OPERATIONS, outboxQueueable } = await import(${JSON.stringify(new URL('../../../../packages/outbox/index.js', import.meta.url).href)});
    const { openBoard, nativeBoardPorts } = await import(${JSON.stringify(new URL('../../../lib/index.js', import.meta.url).href)});
    const { checkpointPublisher } = await import(${PUBLISH});
    const { relayOrdering } = await import(${ORDERING});
    const lines = [], io = { checkpointWorker: ${JSON.stringify(new URL('../../../lib/src/io/worker/checkpoint/relay.js', import.meta.url).pathname)}, openBoard, nativeBoardPorts, withOutboxGuard, replayConflictRecord, remoteBoardMissing, uncertainUploadFailure, decideUncertainBaseline, checkpointPublisher, relayOrdering, checkpointInBackground, scheduleCheckpoint, requestCheckpointCheck, outboxPolicy: () => ({ acknowledgedOperations: ACKNOWLEDGED_OPERATIONS, outboxQueueable }), outboxFields, flushOutbox, queueMove, outboxHasPendingCreatedItem, err: line => lines.push(line), relayTimeoutMs: 300, ...${JSON.stringify(options)} };
    const outcomes = [];
    for (const text of ${JSON.stringify(texts)}) {
      try { await relayOperation(process.cwd(), 'shout', [{ from: 'coordinator', to: 'all', lanes: [], text }], io); outcomes.push('ok'); }
      catch (error) { outcomes.push({ code: error.code, message: error.message }); }
    }
    const local = localRecords(openBoard, process.cwd(), board => board.db.prepare('SELECT shout_text AS text FROM shout').all().map(row => row.text));
    process.stdout.write(JSON.stringify({ outcomes, lines, local }));
  `);
}

/** Pause the first baseline for size, as the 19 Oct submit failure did, then stop the relay answering. */
async function pausedLink(t) {
  const box = await relayClientFixture(t);
  box.legacySnapshotApi('bad-route');
  box.rejectSnapshots({ status: 400, code: 'BAD_REQUEST', message: 'the body exceeds 14000000 bytes; send a smaller snapshot' });
  await box.link();
  box.rejectSnapshots(null);
  assert.ok(link(box).baselinePause, 'the baseline is paused for size');
  return box;
}

/** Leave a baseline unaccepted and unpaused, the state a timed-out first upload leaves behind. */
async function uncertainLink(t) {
  const box = await pausedLink(t);
  const state = link(box);
  delete state.baselinePause;
  writeFileSync(box.linkFile, JSON.stringify(state) + '\n', { mode: 0o600 });
  return box;
}

/** Pause the first baseline with a refusal whose retry reaches the relay, as the #919 lost-ACK review set it up. */
async function refusedLink(t) {
  const box = await relayClientFixture(t);
  box.legacySnapshotApi('bad-route');
  box.rejectSnapshots({ status: 400, code: 'BAD_UPLOAD', message: 'fixture refused the first upload' });
  await box.link();
  box.rejectSnapshots(null);
  assert.ok(link(box).baselinePause, 'the refused baseline is paused');
  return box;
}

/** Read the relay's saved board state with the link's own credential, outside the client under test. */
async function remoteState(box, state) {
  const reply = await fetch(box.origin + '/api/v1/boards/' + state.board + '/state', {
    headers: { authorization: 'Bearer ' + state.token, 'x-pullboard-engine': String(ENGINE_VERSION) },
  });
  const document = await reply.json();
  return { status: reply.status, sequence: document.state?.sequence ?? null,
    digest: typeof document.state?.sealed === 'string' ? createHash('sha256').update(document.state.sealed).digest('hex') : null };
}

/** After the relay answers again, every local move must be inside the one accepted baseline. */
async function assertUploadedLater(box, texts) {
  box.stallApi(false); box.legacySnapshotApi(false);
  const status = await box.cliLocal('status');
  assert.equal(status.code, 0);
  const state = link(box);
  assert.equal(state.baselineAccepted, true, 'the next command uploads the baseline');
  assert.equal(state.baselineStale, undefined);
  const exported = await box.cliLocal('export');
  for (const text of texts) assert.ok(exported.document.tables.shout.some(row => row.shout_text === text), `local move kept: ${text}`);
  assert.equal(box.moveAcks.length, 0, 'the moves went up inside the baseline, not as ordered moves');
}

describe('relay failures never fail a local move [B26,H16,H17]', { concurrency: true }, () => {
for (const [name, setup] of [['a paused link', pausedLink], ['a link whose first upload is uncertain', uncertainLink]]) {
  test(`a timing-out relay never fails a move on ${name}, and the move rides the later baseline [B26,H16,H17]`, async t => {
    const box = await setup(t);
    box.stallApi(true);
    const run = await moves(box, ['first move while the relay stalls', 'second move while the relay stalls']);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(run.document.outcomes, ['ok', 'ok'], 'both moves commit locally');
    assert.deepEqual(run.document.local, ['first move while the relay stalls', 'second move while the relay stalls']);
    assert.equal(run.document.lines.filter(line => /did not answer \(timed out\)/u.test(line)).length, 1, 'the relay failure is reported once');
    await assertUploadedLater(box, run.document.local);
  });

  test(`a busy link lock is waited out with progress, then decided under the lock, on ${name} [B26,H16,H17]`, async t => {
    const box = await setup(t);
    const holder = spawn('sleep', ['30'], { stdio: 'ignore' });
    const lock = box.linkFile + '.lock';
    mkdirSync(lock, { recursive: true, mode: 0o700 });
    writeFileSync(lock + '/pid', String(holder.pid));
    const release = setTimeout(() => { holder.kill(); rmSync(lock, { recursive: true, force: true }); }, 2500);
    t.after(() => { clearTimeout(release); holder.kill(); rmSync(lock, { recursive: true, force: true }); });
    const run = await moves(box, ['move after the lock cleared'], { relayLockProgressMs: 400 });
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(run.document.outcomes, ['ok']);
    assert.ok(run.document.lines.filter(line => /waiting for another worktree/u.test(line)).length >= 2, 'progress lines appear while waiting');
  });
}

for (const [name, setup] of [['a link whose first upload is uncertain', uncertainLink], ['a paused link', refusedLink]]) {
  test(`a lost baseline reply never lets a move commit outside relay order on ${name} [B26,H16]`, async t => {
    const box = await setup(t);
    box.legacySnapshotApi(true);
    const before = link(box);
    assert.equal(before.baselineAccepted, false);
    box.loseNextSnapshotReply({ thenStateReads: { status: 503, code: 'RELAY_UNAVAILABLE' } });
    const text = 'must stay in relay order once the relay may hold the baseline';
    const run = await moves(box, [text], { relayUncertainWaitMs: 1500, relayUncertainProgressMs: 400, relayUncertainRetryMs: 200 });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(box.lostSnapshotReplies().length, 1, 'the relay accepted one baseline whose reply was lost');
    assert.equal(run.document.outcomes[0]?.code, 'RELAY_BASELINE_UNCERTAIN', 'an undecided upload refuses instead of committing locally');
    assert.match(run.document.outcomes[0].message, /run the command again/u);
    assert.deepEqual(run.document.local, [], 'nothing commits outside the relay order');
    assert.equal(box.moveAcks.length, 0);
    assert.ok(run.document.lines.filter(line => /checking whether the relay kept/u.test(line)).length >= 2, 'progress lines appear while deciding');
    assert.ok(link(box).baselineUncertain, 'the undecided upload is saved for the next command');
    box.rejectStateReads(null);
    const remote = await remoteState(box, before);
    assert.deepEqual([remote.status, remote.sequence, remote.digest], [200, 0, box.lostSnapshotReplies()[0]], 'the relay holds the baseline whose reply was lost');
    const retried = await moves(box, [text]);
    assert.deepEqual(retried.document.outcomes, ['ok'], 'the retry decides the upload under the lock, then sends the move');
    assert.deepEqual(retried.document.local, [text]);
    assert.equal(box.moveAcks.length, 1, 'the retried move went through relay order');
    assert.equal(link(box).baselineAccepted, true);
    assert.equal(link(box).baselineUncertain, undefined);
  });
}

test('the public CLI waits out a lost baseline reply and sends the move in relay order [B26,H16]', async t => {
  const box = await uncertainLink(t);
  box.legacySnapshotApi(true);
  box.loseNextSnapshotReply({ thenStateReads: { status: 503, code: 'RELAY_UNAVAILABLE' } });
  const recover = setTimeout(() => box.rejectStateReads(null), 1500); // budget: hang ceiling for the outage the uncertain upload waits out.
  t.after(() => clearTimeout(recover));
  const text = 'public CLI move after a lost baseline reply';
  const result = await box.cliLocal('shout', 'all', text);
  assert.equal(result.code, 0, JSON.stringify(result.document));
  assert.equal(box.lostSnapshotReplies().length, 1, 'the relay accepted one baseline whose reply was lost');
  assert.equal(box.moveAcks.length, 1, 'the move went through relay order once the upload was decided');
  assert.equal(link(box).baselineAccepted, true);
  const exported = await box.cliLocal('export');
  assert.equal(exported.document.tables.shout.filter(row => row.shout_text === text).length, 1);
});

test('a lock held past the wait refuses once with RELAY_BUSY and a retry step [B26,H16]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const holder = spawn('sleep', ['30'], { stdio: 'ignore' });
  const lock = box.linkFile + '.lock';
  mkdirSync(lock, { recursive: true, mode: 0o700 });
  writeFileSync(lock + '/pid', String(holder.pid));
  t.after(() => { holder.kill(); rmSync(lock, { recursive: true, force: true }); });
  const run = await moves(box, ['never sent'], { relayLockWaitMs: 800, relayLockProgressMs: 300 });
  assert.equal(run.document.outcomes[0].code, 'RELAY_BUSY');
  assert.match(run.document.outcomes[0].message, /run the command again/u);
  assert.deepEqual(run.document.local, []);
});

test('on an accepted baseline a stalled relay refuses once with a reason and the retry step, committing nothing [B26,H16]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  assert.equal((await box.cliLocal('status')).code, 0);
  assert.equal(link(box).baselineAccepted, true);
  box.stallApi(true);
  const run = await moves(box, ['must not commit outside the relay order']);
  assert.equal(run.document.outcomes[0].code, 'RELAY_UNAVAILABLE');
  assert.match(run.document.outcomes[0].message, /timed out/u);
  assert.match(run.document.outcomes[0].message, /retry this move when the relay is reachable/u);
  assert.deepEqual(run.document.local, [], 'nothing commits outside the relay order');
});
});
