/** Exact signed-request provenance must replace optional SSH signing at native apply, never named identity [E22,H16]. */
import assert from 'node:assert/strict';
import {
  createHash,
  randomUUID,
  sign,
} from 'node:crypto';
import { join } from 'node:path';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import {
  attestAuthority,
  setPersonSigning,
  personSigning,
} from '../../../../../packages/person/index.js';
import { presenceAttestation } from '../../../../../packages/person/index.js';
import { preparePersonRequest } from '../../../../../packages/person/light.js';
import { loadConfig } from '../../../../../packages/config/index.js';
import {
  applyRelayMove,
  prepareEngineMove,
} from '../../../../../packages/state/index.js';
import {
  receivePersonRequest,
  personRequestRecords,
  requestIntentDigest,
  requestStageText,
} from '../../../../../packages/link/index.js';
import { relayClientFixture } from '../relay/client.js';
import { relayStampKey } from './stamp.js';

/** A consumed genuine OFF stamp cannot disable signing a second time after ordinary re-enable [E22,H16]. */
export async function rejectConsumedOffReplay(t) {
  const box = await relayClientFixture(t);
  const board = openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  // The relay's own stamp key, as the relay vouches for it to this process (#408).
  const relayKey = relayStampKey(box);
  attestAuthority(board, box.origin, relayKey.authority);
  setPersonSigning(board, { agentId: 'coordinator', signed: true });
  const document = preparePersonRequest({ verb: 'signing', args: { signed: 'off' } }, randomUUID());
  const boardId = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='board_id'").get().meta_value;
  const presence = { board: boardId, request: document.id, digest: createHash('sha256').update(JSON.stringify(document)).digest('hex'),
    credential: 'fixture-passkey', at: Date.now() };
  presence.signature = sign(null, presenceAttestation(presence), relayKey.privateKey).toString('base64url');
  const at = new Date().toISOString();
  receivePersonRequest(board, document, { sequence: 1, at, sender: { kind: 'person', userId: 'fixture-user', presence } });
  const executor = 'fixture-executor';
  let sequence = 1;
  /** Use real sealed request execution, never a self-declared presence flag. */
  function execute(operation, args, phase) {
    const record = personRequestRecords(board).find(entry => entry.id === document.id);
    const move = prepareEngineMove(board, operation, args);
    move.personRequest = { id: document.id, executor, phase, digest: requestIntentDigest(record) };
    const outcome = applyRelayMove(board, move, { sequence: ++sequence, at, kind: 'move',
      sender: { kind: 'machine', userId: 'fixture-user', machine: 'fixture-native-device' } });
    assert.equal(outcome.error, undefined, JSON.stringify(outcome));
  }
  const intake = personRequestRecords(board).find(entry => entry.id === document.id);
  execute('shout', [{ from: 'person', to: 'coordinator', text: requestStageText(intake, 'claim'), lanes: Object.keys(loadConfig(box.root).lanes) }], 'claim');
  execute('setPersonSigning', [{ agentId: 'person', signed: false, request: document.id }], 'execute');
  assert.equal(personSigning(board).signed, false, 'a genuine first execution turns signing off');
  const original = board.db.prepare("SELECT * FROM event WHERE event_kind='person_signing' ORDER BY event_id DESC LIMIT 1").get();
  assert.equal(JSON.parse(original.event_detail).request, document.id);
  setPersonSigning(board, { agentId: 'coordinator', signed: true });
  assert.equal(personSigning(board).signed, true, 'ordinary re-enable is the positive control');
  board.db.prepare('INSERT INTO event(event_at,event_by,event_kind,item_id,event_detail) VALUES (?,?,?,?,?)')
    .run(original.event_at, original.event_by, original.event_kind, original.item_id, original.event_detail);
  assert.equal(personSigning(board).signed, true, 'an exact consumed OFF event cannot disable signing again without new presence');
}
