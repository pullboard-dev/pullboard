/** A competing phone execution consumes a request before its elected native receipt arrives [H12,H16,B26]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { appliedSequence, prepareEngineMove } from '../src/engine.js';
import { ENGINE_VERSION } from '../src/machine.js';
import { preparePersonRequest } from '../src/person-request.js';
import { personRequestRecords, requestIntentDigest } from '../src/relay-requests.js';
import { decodeBoardKey, seal } from '../src/seal.js';
import { relayClientFixture } from './relay-client-fixture.js';

const RELAY_MODULE = pathToFileURL(resolve(import.meta.dirname, '../src/relay.js')).href;
const BOARD_MODULE = pathToFileURL(resolve(import.meta.dirname, '../src/board.js')).href;
const REQUESTS_MODULE = pathToFileURL(resolve(import.meta.dirname, '../src/relay-requests.js')).href;
const CONFIG_MODULE = pathToFileURL(resolve(import.meta.dirname, '../src/config.js')).href;
const LANES_MODULE = pathToFileURL(resolve(import.meta.dirname, '../src/lanes.js')).href;

/** Read one real SQLite person-request receipt without opening a transport or changing the board. */
function requestRecord(root, id) {
  const board = store.openBoard(join(root, '.git', 'pullboard', 'board.sqlite'));
  try { return personRequestRecords(board).find(record => record.id === id && !record.duplicateOf); }
  finally { store.closeBoard(board); }
}

/** Seal a browser-format intent and submit it with the real short-lived phone session. */
async function postPhoneRequest(box, boardId, phoneToken, boardKey, document) {
  const sealed = Buffer.from(await seal(boardKey, new TextEncoder().encode(JSON.stringify(document)), {
    boardId, kind: 'request', sequence: 1,
  })).toString('base64url');
  return fetch(box.origin + '/api/v1/boards/' + boardId + '/requests', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + phoneToken, 'content-type': 'application/json', 'x-pullboard-engine': String(ENGINE_VERSION) },
    body: JSON.stringify({ sequence: 1, sealed }),
  });
}

test('a raced native request receipt returns its sender refusal and clears pending state [H12,H16,B26]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const boardKey = decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim());
  const phone = await box.phoneSession();
  const requestId = 'native-race-phone-shout';
  const intent = preparePersonRequest({ verb: 'shout', args: { to: 'coordinator', text: 'PHONE_RACE_SHOUT_ONCE' } }, requestId);
  const acceptedIntent = await postPhoneRequest(box, link.board, phone.token, boardKey, intent);
  assert.equal(acceptedIntent.status, 200, 'the real phone session appends the sealed request at sequence one');
  const acceptedIntentDocument = await acceptedIntent.json();
  assert.equal(acceptedIntentDocument.event?.event_id, 1);
  assert.equal(acceptedIntentDocument.event?.kind, 'request');

  const claim = await box.script(`
    import { join } from 'node:path';
    import { relayRequestDevice, relayOperation, syncRelay } from ${JSON.stringify(RELAY_MODULE)};
    import { openBoard, closeBoard } from ${JSON.stringify(BOARD_MODULE)};
    import { personRequestRecords, requestIntentDigest, requestStageText } from ${JSON.stringify(REQUESTS_MODULE)};
    import { loadConfig } from ${JSON.stringify(CONFIG_MODULE)};
    import { laneNames } from ${JSON.stringify(LANES_MODULE)};
    const root = process.cwd();
    const sink = { write() {} };
    const io = { cwd: root, stdout: sink, stderr: sink, say() {}, err() {}, onEvent() {} };
    await syncRelay(root, io);
    const executor = await relayRequestDevice(root);
    const board = openBoard(join(root, '.git', 'pullboard', 'board.sqlite'));
    let record;
    try { record = personRequestRecords(board).find(entry => entry.id === ${JSON.stringify(requestId)} && !entry.duplicateOf); }
    finally { closeBoard(board); }
    const message = { from: 'person', to: 'coordinator', text: requestStageText(record, 'claim'), lanes: laneNames(loadConfig(root)) };
    const result = await relayOperation(root, 'shout', [message], {
      ...io,
      personRequest: { id: record.id, executor, phase: 'claim', digest: requestIntentDigest(record) },
      personRequestMoveId: 'native-race-claim-' + record.id,
    });
    process.stdout.write(JSON.stringify({ claimRecorded: Number.isSafeInteger(result), executor }));
  `);
  assert.equal(claim.code, 0, 'the native replica synchronizes the request and records one elected executor');
  assert.equal(claim.document.claimRecorded, true);
  const record = requestRecord(box.root, requestId);
  assert.ok(record?.executor, 'the sequence-two claim receipt elected a native request executor');
  assert.equal(record.sequence, 1, 'the authenticated request is the first ordered position');
  const claimedBoard = store.openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  try { assert.equal(appliedSequence(claimedBoard), 2, 'the elected executor claim is acknowledged at sequence two'); }
  finally { store.closeBoard(claimedBoard); }

  const otherMachine = await fetch(box.origin + '/auth/machines', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + phone.token, 'content-type': 'application/json', 'x-pullboard-engine': String(ENGINE_VERSION) },
    body: JSON.stringify({ board: link.board, machine: 'race-winning-machine' }),
  });
  assert.equal(otherMachine.status, 201, 'the real phone session authorizes an independent board-scoped PM');
  const otherMachineDocument = await otherMachine.json();
  assert.equal(otherMachineDocument.board, link.board);
  assert.equal(otherMachineDocument.machine, 'race-winning-machine');
  assert.equal(/^pm_[A-Za-z0-9_-]{43}$/u.test(otherMachineDocument.token ?? ''), true,
    'the independent credential is a real board-scoped machine token');

  const competingBoard = store.openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  let competingMove;
  try {
    competingMove = prepareEngineMove(competingBoard, 'shout', [{
      from: 'person', to: record.move.args.to, text: record.move.args.text, lanes: [],
    }], { id: 'phone-race-winning-execution' });
    competingMove.personRequest = {
      id: record.id, executor: record.executor, phase: 'execute', digest: requestIntentDigest(record),
    };
  } finally { store.closeBoard(competingBoard); }
  const competingCiphertext = Buffer.from(await seal(boardKey, new TextEncoder().encode(JSON.stringify(competingMove)), {
    boardId: link.board, kind: 'move', sequence: 3,
  })).toString('base64url');
  let competingStatus;
  let competingSequence;
  box.beforeNextMove(async () => {
    const response = await fetch(box.origin + '/api/v1/boards/' + link.board + '/moves', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + otherMachineDocument.token, 'content-type': 'application/json', 'x-pullboard-engine': String(ENGINE_VERSION) },
      body: JSON.stringify({ sequence: 3, sealed: competingCiphertext }),
    });
    competingStatus = response.status;
    const document = await response.json();
    competingSequence = document.event?.event_id;
  });

  const movePostPath = `/api/v1/boards/${link.board}/moves`;
  const postsBefore = box.calls.filter(call => call.method === 'POST' && call.path === movePostPath).length;
  const execution = await box.script(`
    import { readFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { relayOperation, syncRelay } from ${JSON.stringify(RELAY_MODULE)};
    import { Refused } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, '../src/refused.js')).href)};
    const root = process.cwd();
    const sink = { write() {} };
    const io = { cwd: root, stdout: sink, stderr: sink, say() {}, err() {}, onEvent() {} };
    await syncRelay(root, io);
    let refusal = null;
    try {
      await relayOperation(root, 'shout', [{ from: 'person', to: 'coordinator', text: 'PHONE_RACE_SHOUT_ONCE', lanes: [] }], {
        ...io,
        personRequest: { id: ${JSON.stringify(requestId)}, executor: ${JSON.stringify(record.executor)}, phase: 'execute', digest: ${JSON.stringify(requestIntentDigest(record))} },
        personRequestMoveId: 'native-race-execution-${requestId}',
      });
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      refusal = error.code;
    }
    const state = JSON.parse(readFileSync(${JSON.stringify(box.linkFile)}, 'utf8'));
    process.stdout.write(JSON.stringify({ refusal, pendingCleared: state.pending === undefined }));
  `);
  assert.equal(execution.code, 0, 'the native process completes the real relay race without an unhandled failure');
  assert.equal(competingStatus, 200, 'the competing authenticated machine wins the request at sequence three');
  assert.equal(competingSequence, 3);
  assert.equal(execution.document.refusal, 'RELAY_PERSON_ONLY', 'the elected native receipt reports its original sender refusal');
  assert.equal(execution.document.pendingCleared, true, 'the matching durable sender-refusal receipt clears pending state');
  const postsAfter = box.calls.filter(call => call.method === 'POST' && call.path === movePostPath).length;
  assert.equal(postsAfter - postsBefore, 3, 'the race uses winner, collision and one refused retry posts, not an unbounded resend loop');

  const ordinary = await box.script(`
    import { relayOperation } from ${JSON.stringify(RELAY_MODULE)};
    const root = process.cwd();
    const sink = { write() {} };
    const io = { cwd: root, stdout: sink, stderr: sink, say() {}, err() {}, onEvent() {} };
    const result = await relayOperation(root, 'shout', [{ from: 'coordinator', to: 'all', text: 'ordinary agent shout after phone race', lanes: [] }], io);
    process.stdout.write(JSON.stringify({ acknowledged: Number.isSafeInteger(result) }));
  `);
  assert.equal(ordinary.code, 0, 'the native machine remains able to issue ordinary agent work');
  assert.equal(ordinary.document.acknowledged, true);

  const verified = store.openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  try {
    assert.equal(appliedSequence(verified), 5, 'the winner, refusal and later agent move each consume one relay position');
    assert.equal(verified.db.prepare('SELECT COUNT(*) AS count FROM shout WHERE shout_from=? AND shout_text=?').get('person', 'PHONE_RACE_SHOUT_ONCE').count,
      1, 'only the winning phone-authorized execution creates the requested person shout');
  } finally { store.closeBoard(verified); }
});
