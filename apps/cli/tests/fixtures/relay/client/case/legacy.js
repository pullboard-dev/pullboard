/** Keep the accepted legacy-mirror migration assertions together as a focused relay fixture helper [H16,S1]. */
import assert from 'node:assert/strict';
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { ENGINE_VERSION } from '../../../../../../../packages/state/index.js';

/** Read native gzip snapshots while retaining checks against historical uncompressed records. */
function snapshotDocument(plain) {
  return JSON.parse(Buffer.from(plain[0] === 0x1f && plain[1] === 0x8b ? gunzipSync(plain) : plain).toString('utf8'));
}

/** Exercise migration of an old local-first mirror queue into the ordered native checkpoint. */
export async function legacyMirrorQueueFragment({
  relay, root, relayEnv, boardFile, linkFile, lane, lanes, boardId, key, currentMachineToken,
  localEvents, cli, store, unseal,
}) {
  const priorRows = localEvents(boardFile);
  const link = JSON.parse(readFileSync(linkFile, 'utf8'));
  assert.equal(link.mode, 'ordered');
  link.cursor = priorRows.at(-1)?.event_id ?? 0;
  // Model the pre-161 local-first outbox: old link metadata plus local rows committed before upload.
  delete link.mode;
  delete link.presentationDigest;
  writeFileSync(linkFile, JSON.stringify(link) + '\n', { mode: 0o600 });

  const board = store.openBoard(boardFile);
  try {
    store.addItem(board, {
      by: 'coordinator', lane, title: 'legacy queued item', criterion: 'queued before ordered mode',
    });
    store.shout(board, {
      from: 'coordinator', to: 'person', text: 'legacy queued shout', lanes,
    });
  } finally { store.closeBoard(board); }

  const queuedRows = localEvents(boardFile);
  const queuedEvents = queuedRows.slice(priorRows.length);
  assert.deepEqual(queuedEvents.map((event) => event.event_kind), ['add', 'milestone_placed', 'shout']);
  const initialUploadCount = relay.uploads.length;
  const expectedBehind = queuedEvents.length;

  relay.failMoves(true);
  const offline = await cli(root, relayEnv, 'status');
  assert.equal(offline.relay.behind, expectedBehind, 'the legacy local rows remain in the durable queue');
  assert.deepEqual(localEvents(boardFile), queuedRows, 'a failed migration leaves local rows untouched');
  assert.equal(relay.uploads.length, initialUploadCount, 'refused uploads are not acknowledged');
  const pendingLegacy = JSON.parse(readFileSync(linkFile, 'utf8'));
  assert.equal(pendingLegacy.pending.sequence, link.sequence + 1);
  assert.equal(pendingLegacy.pending.needsPresentation, true, 'the first legacy row has no projection covering its position');

  relay.failMoves(false);
  const resumed = await cli(root, relayEnv, 'status');
  assert.equal(resumed.relay.behind, 0, 'the next reachable command drains the queued legacy rows');
  assert.deepEqual(localEvents(boardFile), queuedRows, 'migration checkpoints existing rows instead of replaying them');
  const legacyUploads = relay.uploads.slice(initialUploadCount);
  const lastSequence = link.sequence + queuedEvents.length;
  assert.deepEqual(legacyUploads.map((upload) => upload.sequence),
    queuedEvents.map((_, index) => link.sequence + 1 + index), 'one ordered upload per queued legacy row');
  const openedLegacy = await Promise.all(legacyUploads.map(async (upload) => JSON.parse(new TextDecoder().decode(await unseal(
    key, Buffer.from(upload.sealed, 'base64url'), { boardId, kind: 'move', sequence: upload.sequence },
  )))));
  assert.equal(openedLegacy[0].presentation, undefined, 'the historical first move cannot attest the later row');
  assert.equal(openedLegacy.at(-1).presentation.state.events[0].event_id, queuedEvents.at(-1).event_id, 'the final legacy move carries only its matching projection');

  const authorization = { 'x-pullboard-engine': String(ENGINE_VERSION), authorization: `Bearer ${currentMachineToken}` };
  const stateResponse = await fetch(`${relay.origin}/api/v1/boards/${boardId}/state`, { headers: authorization });
  assert.equal(stateResponse.status, 200);
  const stateDocument = await stateResponse.json();
  assert.equal(stateDocument.state.sequence, lastSequence, 'the native checkpoint covers the complete ordered prefix');
  const checkpoint = snapshotDocument(await unseal(
    key, Buffer.from(stateDocument.state.sealed, 'base64url'), { boardId, kind: 'snapshot', sequence: lastSequence },
  ));
  assert.deepEqual(checkpoint.tables.event.slice(priorRows.length), queuedEvents,
    'the source-native snapshot records both legacy rows in order');
  assert.ok(checkpoint.presentation.state.items.some((item) => item.title === 'legacy queued item'));

  const repeated = await cli(root, relayEnv, 'status');
  assert.equal(repeated.relay.behind, 0);
  assert.deepEqual(localEvents(boardFile), queuedRows, 'a repeated sync does not execute legacy rows again');
  assert.equal(relay.uploads.length, initialUploadCount + queuedEvents.length, 'a repeated sync does not append duplicate uploads');
  const unchangedResponse = await fetch(`${relay.origin}/api/v1/boards/${boardId}/state`, { headers: authorization });
  assert.equal((await unchangedResponse.json()).state.sealed, stateDocument.state.sealed,
    'a repeated sync leaves the acknowledged native checkpoint unchanged');
}
