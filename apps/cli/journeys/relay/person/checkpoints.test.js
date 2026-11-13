// pullboard: browser
/** @pullboard-test-gui */
/** A paired browser seals person intent; only native Pullboard executes it [H12,H16,B26]. These cases time and trace API1
 * snapshot PUTs, so they run on the legacy wire (#903); API2 person moves are proven in relay-person-actions.test.js. */
import assert from 'node:assert/strict';
import {
  createHash,
} from 'node:crypto';
import {
  randomUUID,
} from 'node:crypto';
import {
  readFileSync,
} from 'node:fs';
import {
  test,
} from 'node:test';
import {
  gunzipSync,
} from 'node:zlib';
import {
  decodeBoardKey,
} from '../../../../../packages/kernel/index.js';
import {
  seal,
} from '../../../../../packages/kernel/index.js';
import {
  unseal,
} from '../../../../../packages/kernel/index.js';
import {
  ENGINE_VERSION,
} from '../../../../../packages/state/index.js';
import {
  assertSnapshotCheckpoints,
} from '../../../tests/fixtures/relay/client.js';
import {
  cliChildDeadlineMs,
} from '../../../tests/fixtures/relay/client.js';
import {
  legacyRelayClientFixture as relayClientFixture,
} from '../../../tests/fixtures/relay/client.js';


test('a timed-out checkpoint PUT retries identical ciphertext through the native status flow [H16,C7]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const key = decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim());
  const intent = { version: 1, type: 'person-request', id: randomUUID(),
    move: { verb: 'shout', args: { to: 'coordinator', text: 'RETRY_CHECKPOINT_CONTROL' } } };
  const sealed = Buffer.from(await seal(key, new TextEncoder().encode(JSON.stringify(intent)), {
    boardId: link.board, kind: 'request', sequence: 1,
  })).toString('base64url');
  const response = await fetch(box.origin + '/api/v1/boards/' + link.board + '/requests', {
    method: 'POST', headers: { authorization: 'Bearer ' + (await box.phoneSession()).token,
      'x-pullboard-engine': String(ENGINE_VERSION), 'content-type': 'application/json' },
    body: JSON.stringify({ sequence: 1, sealed }),
  });
  assert.equal(response.status, 200);
  const before = box.snapshotWriteRecords().length;
  // The claim receipt times out; the nested CLI sync must resend its persisted bytes.
  box.delaySnapshotWriteOnce(2, 10100);
  const result = await box.cliWithSnapshotTrace(3, 'status');
  assert.equal(result.code, 0);
  const trace = result.snapshotTrace;
  t.diagnostic('controlled checkpoint abort/retry: ' + JSON.stringify({ fetches: trace,
    relayReceives: box.snapshotWriteRecords().slice(before) }));
  assertSnapshotCheckpoints(trace, 3);
  assert.equal(trace.length, 4, 'one product abort adds exactly one transport attempt');
  assert.equal(trace[1].abort?.name, 'TimeoutError');
  assert.ok(trace[1].elapsedMs >= 9900, 'the actual ten-second product request bound expired'); // budget: declared ten-second product request deadline (9900ms lower bound).
  assert.equal(trace[2].sequence, trace[1].sequence);
  assert.equal(trace[2].ciphertext, trace[1].ciphertext);
  assert.equal(trace[2].status, 200);
  assert.equal(result.snapshotDeadlineMs, cliChildDeadlineMs(trace.length));
  const exported = (await box.cliLocal('export')).document;
  assert.equal(exported.tables.shout.filter(row => row.shout_text === 'RETRY_CHECKPOINT_CONTROL').length, 1,
    'the identical checkpoint retry does not execute the person intent twice');
});

/** Prove that a newer committed snapshot covers a timed-out earlier projection. */

test('a newer acknowledged checkpoint covers an earlier timed-out PUT [H16,C7]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const key = decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim());
  const intent = { version: 1, type: 'person-request', id: randomUUID(),
    move: { verb: 'shout', args: { to: 'coordinator', text: 'COVERED_CHECKPOINT_CONTROL' } } };
  const sealed = Buffer.from(await seal(key, new TextEncoder().encode(JSON.stringify(intent)), {
    boardId: link.board, kind: 'request', sequence: 1,
  })).toString('base64url');
  const response = await fetch(box.origin + '/api/v1/boards/' + link.board + '/requests', {
    method: 'POST', headers: { authorization: 'Bearer ' + (await box.phoneSession()).token,
      'x-pullboard-engine': String(ENGINE_VERSION), 'content-type': 'application/json' },
    body: JSON.stringify({ sequence: 1, sealed }),
  });
  assert.equal(response.status, 200);
  const before = box.snapshotWriteRecords().length;
  // The initial checkpoint times out before newer committed receipt checkpoints replace it.
  box.delaySnapshotWriteOnce(1, 10100);
  const result = await box.cliWithSnapshotTrace(3, 'status');
  assert.equal(result.code, 0);
  const trace = result.snapshotTrace;
  t.diagnostic('controlled superseded checkpoint: ' + JSON.stringify({ fetches: trace,
    relayReceives: box.snapshotWriteRecords().slice(before) }));
  assertSnapshotCheckpoints(trace, 3);
  assert.equal(trace.length, 3, 'a newer committed checkpoint supersedes the timed-out projection');
  assert.equal(trace[0].abort?.name, 'TimeoutError');
  assert.ok(trace[0].elapsedMs >= 9900, 'the actual ten-second product request bound expired'); // budget: declared ten-second product request deadline (9900ms lower bound).
  assert.ok(trace[1].sequence > trace[0].sequence);
  assert.ok(trace[2].sequence > trace[1].sequence);
  assert.equal(trace[2].status, 200);
  assert.equal(result.snapshotDeadlineMs, cliChildDeadlineMs(trace.length));
  const stateResponse = await fetch(box.origin + '/api/v1/boards/' + link.board + '/state', {
    headers: { authorization: 'Bearer ' + link.token, 'x-pullboard-engine': String(ENGINE_VERSION) },
  });
  assert.equal(stateResponse.status, 200);
  const saved = (await stateResponse.json()).state;
  assert.equal(saved.sequence, trace.at(-1).sequence, 'the relay retains the newest acknowledged checkpoint');
  assert.equal(createHash('sha256').update(saved.sealed).digest('hex'), trace.at(-1).ciphertext);
  const opened = await unseal(key, Buffer.from(saved.sealed, 'base64url'), {
    boardId: link.board, kind: 'snapshot', sequence: saved.sequence,
  });
  const plaintext = opened[0] === 0x1f && opened[1] === 0x8b ? gunzipSync(opened) : opened;
  const restored = JSON.parse(new TextDecoder().decode(plaintext));
  const exported = (await box.cliLocal('export')).document;
  assert.equal(Number(exported.tables.board_meta.find(row => row.meta_key === 'relay_applied_sequence').meta_value), saved.sequence);
  assert.equal(Number(restored.tables.board_meta.find(row => row.meta_key === 'relay_applied_sequence').meta_value), saved.sequence);
  assert.equal(restored.tables.shout.filter(row => row.shout_text === 'COVERED_CHECKPOINT_CONTROL').length, 1);
  assert.equal(exported.tables.shout.filter(row => row.shout_text === 'COVERED_CHECKPOINT_CONTROL').length, 1,
    'the covering checkpoint does not execute the person intent twice');
});
