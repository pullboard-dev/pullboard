/** @pullboard-test-input apps/cli/pullboard.js apps/lib/index.js apps/lib/src/io/worker/checkpoint/relay.js packages/link/index.js packages/outbox/index.js */
/** Legacy API1 baseline refusals pause, race and retry without losing local work; the stuck-agent journey lives in upload.test.js [H16,B26]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import {
  closingFetch,
  privatePersonSession,
  relayClientFixture,
  uploadedState,
} from '../../tests/fixtures/relay/upload.js';

// The subtests each start their own private relay fixture, so they run side by side.
test('a refused baseline upload pauses once, fences races and retries transient refusals [H16,B26]', { concurrency: 4 }, async (t) => {
  const pending = [];
  const sub = (...args) => { const run = t.test(...args); pending.push(run); return run; };
  /** Each internal move in a long-running command retains its own loud pause notice. */
  sub('multiple local moves in one session do not repeat the refused baseline notice [H16,B26]', async subtest => {
    const repeated = await relayClientFixture(subtest);
    repeated.rejectSnapshots({ status: 400, code: 'BAD_REQUEST', message: 'fixture refuses the initial baseline until repaired' });
    await repeated.link();
    const before = repeated.calls.filter(call => call.method === 'PUT' && call.path.endsWith('/state')).length;
    const result = await repeated.script(`
      const { syncRelay, relayOperation } = await import(${JSON.stringify(new URL('../../../../packages/link/index.js', import.meta.url).href)});
      const { withOutboxGuard } = await import(${JSON.stringify(new URL('../../../../packages/outbox/index.js', import.meta.url).href)});
      const { replay: replayConflictRecord } = await import(${JSON.stringify(new URL('../../../../packages/outbox/index.js', import.meta.url).href)});
      const { remoteBoardMissing, uncertainUploadFailure, decideUncertainBaseline } = await import(${JSON.stringify(new URL('../../../../packages/outbox/index.js', import.meta.url).href)});
      const { checkpointInBackground, scheduleCheckpoint, requestCheckpointCheck } = await import(${JSON.stringify(new URL('../../../../packages/outbox/index.js', import.meta.url).href)});
      const { flushOutbox, queueMove, outboxHasPendingCreatedItem, outboxFields, ACKNOWLEDGED_OPERATIONS, outboxQueueable } = await import(${JSON.stringify(new URL('../../../../packages/outbox/index.js', import.meta.url).href)});
      const { openBoard, nativeBoardPorts } = await import(${JSON.stringify(new URL('../../../lib/index.js', import.meta.url).href)});
      const { checkpointPublisher } = await import(${JSON.stringify(new URL('../../../../packages/outbox/index.js', import.meta.url).href)});
      const { relayOrdering } = await import(${JSON.stringify(new URL('../../../../packages/outbox/index.js', import.meta.url).href)});
      const diagnostics = [];
      const io = { checkpointWorker: ${JSON.stringify(new URL('../../../lib/src/io/worker/checkpoint/relay.js', import.meta.url).pathname)}, openBoard, nativeBoardPorts, withOutboxGuard, replayConflictRecord, remoteBoardMissing, uncertainUploadFailure, decideUncertainBaseline, checkpointPublisher, relayOrdering, checkpointInBackground, scheduleCheckpoint, requestCheckpointCheck, outboxPolicy: () => ({ acknowledgedOperations: ACKNOWLEDGED_OPERATIONS, outboxQueueable }), outboxFields, flushOutbox, queueMove, outboxHasPendingCreatedItem, /** Retain safe diagnostic lines for exact per-move counts. */ err: line => diagnostics.push(line) };
      try {
      await syncRelay(process.cwd(), io);
      await relayOperation(process.cwd(), 'shout', [{ from: 'coordinator', to: 'all', lanes: [], text: 'first internal paused move' }], io);
      await relayOperation(process.cwd(), 'shout', [{ from: 'coordinator', to: 'all', lanes: [], text: 'second internal paused move' }], io);
      await syncRelay(process.cwd(), io);
      process.stdout.write(JSON.stringify({ diagnostics }));
      } catch (error) { process.stdout.write(JSON.stringify({ error: { code: error.code, message: error.message } })); process.exitCode = 1; }
    `);
    assert.equal(result.code, 0);
    assert.equal(result.document.diagnostics.filter(line => /relay paused for /u.test(line)).length, 0,
      'the session was already notified when linking; internal moves do not repeat it');
    assert.equal(repeated.calls.filter(call => call.method === 'PUT' && call.path.endsWith('/state')).length - before, 1,
      'one command attempts only one fresh baseline despite multiple local moves');
    assert.equal(repeated.moveAcks.length, 0, 'unaccepted local moves never become sequence-one uploads');
  });

  /** Two authenticated device sessions contend for one real SQLite baseline slot. */
  sub('concurrent initial baseline uploads accept exactly one device [H16]', async subtest => {
    const race = await relayClientFixture(subtest);
    race.rejectSnapshots({ status: 400, code: 'BAD_UPLOAD', message: 'fixture retains two native baseline candidates' });
    await race.link();
    const first = JSON.parse(race.transit.find(row => row.method === 'PUT' && row.path.endsWith('/state')).request.toString('utf8'));
    assert.equal((await race.cli('add', race.lane, 'local work in the second baseline candidate')).code, 0);
    assert.equal((await race.cli('status')).code, 0);
    const second = JSON.parse(race.transit.filter(row => row.method === 'PUT' && row.path.endsWith('/state')).at(-1).request.toString('utf8'));
    assert.notEqual(first.sealed, second.sealed);
    race.rejectSnapshots(null);
    const state = JSON.parse(readFileSync(race.linkFile, 'utf8'));
    const secondSession = await privatePersonSession(race);
    const candidates = [first, second];
    const sessions = [state.token, secondSession];
    const replies = await Promise.all(candidates.map((candidate, index) => closingFetch(race.origin + '/api/v1/boards/' + state.board + '/state', {
      method: 'PUT', headers: { authorization: 'Bearer ' + sessions[index], 'content-type': 'application/json',
        'x-pullboard-engine': String(ENGINE_VERSION), 'if-none-match': '*' }, body: JSON.stringify(candidate),
    })));
    assert.deepEqual(replies.map(reply => reply.status).sort(), [200, 412], 'one atomic baseline creator wins and one receives a precondition refusal');
    const loser = replies.find(reply => reply.status === 412);
    assert.equal((await loser.json()).error.code, 'BASELINE_EXISTS');
    const winnerIndex = replies.findIndex(reply => reply.status === 200);
    assert.equal((await uploadedState(race)).sealed, candidates[winnerIndex].sealed, 'the winning ciphertext is never replaced by the loser');
    const replacement = candidates[1 - winnerIndex];
    const checkpoint = await closingFetch(race.origin + '/api/v1/boards/' + state.board + '/state', {
      method: 'PUT', headers: { authorization: 'Bearer ' + state.token, 'content-type': 'application/json',
        'x-pullboard-engine': String(ENGINE_VERSION) }, body: JSON.stringify(replacement),
    });
    assert.equal(checkpoint.status, 200, 'ordinary later snapshots remain replaceable at their covered sequence');
    assert.equal((await uploadedState(race)).sealed, replacement.sealed);
  });

  /** A competing native snapshot arrives after absence was checked but before the client PUT. */
  sub('a baseline race fences the native retry without discarding local work [H16]', async subtest => {
    const race = await relayClientFixture(subtest);
    race.rejectSnapshots({ status: 400, code: 'BAD_UPLOAD', message: 'fixture baseline pause before a competing device' });
    await race.link();
    const competing = JSON.parse(race.transit.find(row => row.method === 'PUT' && row.path.endsWith('/state')).request.toString('utf8'));
    assert.equal((await race.cli('add', race.lane, 'preserved unaccepted local work')).code, 0);
    race.rejectSnapshots(null);
    const state = JSON.parse(readFileSync(race.linkFile, 'utf8'));
    const secondSession = await privatePersonSession(race);
    let conditional;
    let competingStatus;
    race.beforeNextSnapshot(async headers => {
      conditional = headers['if-none-match'];
      const reply = await closingFetch(race.origin + '/api/v1/boards/' + state.board + '/state', {
        method: 'PUT', headers: { authorization: 'Bearer ' + secondSession, 'content-type': 'application/json',
          'x-pullboard-engine': String(ENGINE_VERSION), 'if-none-match': '*' }, body: JSON.stringify(competing),
      });
      competingStatus = reply.status;
      await reply.arrayBuffer();
      race.rejectStateReads({ status: 503, code: 'RELAY_UNAVAILABLE' });
    });
    const blocked = await race.cli('add', race.lane, 'must not overwrite the competing baseline');
    assert.equal(competingStatus, 200);
    assert.equal(conditional, '*', 'the real native client asks for an atomic initial upload');
    assert.equal(blocked.code, 1);
    assert.equal(blocked.document.error.code, 'RELAY_BASELINE_EXISTS');
    assert.equal(JSON.parse(readFileSync(race.linkFile, 'utf8')).baselineConflict, true, 'the atomic conflict is durable even when a following state read would fail');
    race.rejectStateReads(null);
    const remote = await uploadedState(race);
    assert.equal(remote.sealed, competing.sealed);
    assert.equal(remote.document.tables.item.some(row => row.item_title === 'preserved unaccepted local work'), false);
    const local = await race.cli('export');
    assert.ok(local.document.tables.item.some(row => row.item_title === 'preserved unaccepted local work'), 'the conflicting local work survives for export');
    assert.equal(local.document.tables.item.some(row => row.item_title === 'must not overwrite the competing baseline'), false);
    assert.equal(race.moveAcks.length, 0);
  });

  /** Prove that malformed permanent refusals pause and recover from a fresh snapshot. */
  sub('malformed baseline refusals carry their reason and recover [H16]', async (subtest) => {
    const malformed = await relayClientFixture(subtest);
    malformed.rejectSnapshots({ status: 400, code: 'BAD_UPLOAD', message: 'send only a sequence and sealed payload' });
    const linked = await malformed.link();
    const paused = await malformed.cli('status');
    assert.equal(paused.code, 0);
    assert.equal((paused.document.diagnostics ?? []).filter(line => /relay paused/u.test(line)).length, 0, 'the link already delivered this session notice');
    const notice = (linked.document.diagnostics ?? []).join('\n');
    assert.match(notice, /BAD_UPLOAD/u);
    assert.match(notice, /send only a sequence and sealed payload/u);
    assert.match(notice, /upgrade pullboard|pullboard relay on/u, 'the malformed-upload notice gives its recovery step');
    malformed.rejectSnapshots(null);
    const recovered = await malformed.cli('status');
    assert.equal(recovered.code, 0);
    assert.doesNotMatch((recovered.document.diagnostics ?? []).join('\n'), /relay paused/u);
  });

  /** Preserve ordinary retry behavior for every retryable HTTP response status. */
  for (const status of [408, 425, 429, 503]) {
    sub(`transient snapshot HTTP ${status} keeps retry behavior [H16]`, async (subtest) => {
      const transient = await relayClientFixture(subtest);
      transient.rejectSnapshots({ status, code: 'RELAY_UNAVAILABLE', message: `fixture snapshot HTTP ${status}` });
      await transient.link();
      const title = `not applied before baseline HTTP ${status}`;
      const kept = await transient.cli('add', transient.lane, title);
      assert.equal(kept.code, 0, 'a retryable outage never fails a local move before the baseline is accepted [B26]');
      assert.doesNotMatch((kept.document.diagnostics ?? []).join('\n'), /relay paused/u,
        'retryable statuses never activate the permanent baseline pause');
      assert.equal(JSON.parse(readFileSync(transient.linkFile, 'utf8')).baselinePause, undefined);
      transient.rejectSnapshots(null);
      const retried = await transient.cli('status');
      assert.equal(retried.code, 0, 'the next command uploads the baseline once the transient failure clears');
      const exported = await transient.cli('export');
      assert.equal(exported.document.tables.item.filter(row => row.item_title === title).length, 1, 'the move rides the later baseline once');
      assert.equal(transient.moveAcks.length, 0);
    });
  }


  await Promise.all(pending);
});
