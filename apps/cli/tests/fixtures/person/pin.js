import { personSigning as nativePersonSigning } from '../../../../../packages/person/index.js';
import { setPersonSigning as nativeSetPersonSigning } from '../../../../../packages/person/index.js';
/** Initial unpaired authority insertion uses only an owned private board, never shared SQLite [E22,B26,H16]. */
import assert from 'node:assert/strict';
import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
} from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { presenceAttestation } from '../../../../../packages/person/index.js';
import {
  relayClientFixture,
  relayFixtureChild,
} from '../relay/client.js';

const CLI = resolve(import.meta.dirname, '../../../pullboard.js');

/** A local first-row insertion cannot supply the missing person/relay trust anchor on an unpaired signed board. */
export function firstUnpairedAuthorityInsertion(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-person-first-pin-'));
  const board = openBoard(join(directory, 'board.sqlite'));
  t.after(() => { store.closeBoard(board); rmSync(directory, { recursive: true, force: true }); });
  const boardId = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='board_id'").get().meta_value;
  nativeSetPersonSigning(board, { agentId: 'coordinator', signed: true });
  assert.equal(board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='person_authority_local'").get(), undefined,
    'the board has never pinned an authority or paired a phone');
  assert.equal(board.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'person_authority_%'").all().length, 0,
    'no legitimate first-pin triggers exist; this control never drops or alters a trigger');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const request = randomUUID();
  const intent = { version: 1, type: 'person-request', id: request, move: { verb: 'signing', args: { signed: 'off' } } };
  const presence = { board: boardId, request, digest: createHash('sha256').update(JSON.stringify(intent)).digest('hex'),
    credential: 'local-forged-credential', at: Date.now() };
  presence.signature = sign(null, presenceAttestation(presence), privateKey).toString('base64url');
  // The forged off is exact and correctly signed by an unrelated local key; it is not a apps/relay/src/io/deploy/person attestation.
  board.db.prepare('INSERT INTO event(event_at,event_by,event_kind,item_id,event_detail) VALUES (?,?,?,?,?)')
    .run(new Date().toISOString(), 'person', 'person_signing', null, JSON.stringify({ signed: false, request, presence, intent }));
  assert.equal(nativePersonSigning(board).signed, true, 'without an authenticated authority the forged off is ignored');
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?)').run('person_authority_local', JSON.stringify({
    origin: 'https://unrelated-fixture.invalid', publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
  }));
  assert.equal(nativePersonSigning(board).signed, true,
    'an initial raw local authority row cannot turn signing off on an unpaired board');
}

/**
 * The shipped CLI takes a first pin only from the built-in relay over TLS: a linked loopback relay over http, or any
 * other origin, cannot vouch for the person, even with a planted preload or variable, so signing stays off and nothing
 * is pinned. Only a caller's own explicit parameter (apps/cli/tests/fixtures/person/trusted.js) can name another relay.
 */
export async function firstPinNeedsBuiltInRelay(t) {
  const box = await relayClientFixture(t);
  assert.equal((await box.link()).code, 0);
  // Any switch a shell can set is no authority: a preload that plants a trust hook, as an agent could, changes nothing.
  const planted = `globalThis[Symbol.for('pullboard.personAuthorityFixtureOrigin')] = () => true; globalThis.trustedRelayOrigin = ${JSON.stringify(box.origin)};`;
  const env = { ...box.env, PULLBOARD_TRUSTED_RELAY_ORIGIN: box.origin,
    NODE_OPTIONS: [box.env.NODE_OPTIONS, `--import=data:text/javascript,${encodeURIComponent(planted)}`].filter(Boolean).join(' ') };
  const pinned = () => {
    const board = openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
    try { return board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='person_authority_local'").get(); }
    finally { store.closeBoard(board); }
  };
  const turnOn = async () => relayFixtureChild(box.root, env, [CLI, 'settings', 'person.signed', 'on', '--json']);
  const overHttp = await turnOn();
  assert.equal(overHttp.document.error?.code, 'PERSON_SIGNING_RELAY', `an http relay cannot vouch: ${JSON.stringify(overHttp.document)}`);
  assert.equal(pinned(), undefined, 'nothing is pinned from an http origin');
  // Another https origin is refused by name before any request leaves the machine.
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  writeFileSync(box.linkFile, JSON.stringify({ ...link, url: 'https://relay.example.invalid' }));
  const calls = box.calls.length;
  const elsewhere = await turnOn();
  assert.equal(elsewhere.document.error?.code, 'PERSON_SIGNING_RELAY', `a non-built-in origin cannot vouch: ${JSON.stringify(elsewhere.document)}`);
  assert.equal(pinned(), undefined, 'nothing is pinned from a non-built-in origin');
  assert.equal(box.calls.slice(calls).filter(call => call.path === '/.well-known/pullboard-person-authority').length, 0, 'no authority request was made');
  writeFileSync(box.linkFile, JSON.stringify(link));
}
