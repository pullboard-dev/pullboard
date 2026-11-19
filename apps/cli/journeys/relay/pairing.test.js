/** One-time pairing keeps its secret off the relay and rejects replay or expiry [H15,H17]. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import { createPairingCode } from '../../../../packages/person/index.js';
import { openPairingBundle } from '../../../../packages/person/index.js';
import { parsePairingCode } from '../../../../packages/person/index.js';
import { sealPairingBundle } from '../../../../packages/person/index.js';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import { createPairingStore } from '../../../relay/index.js';
import { PAIR_PACKAGE_BYTES } from '../../../../packages/link/index.js';

const BOARD = '0123456789abcdef0123456789abcdef';
const OTHER_BOARD = 'fedcba9876543210fedcba9876543210';

/** Create the exact native-export envelope expected from a linked device. */
function bundle(overrides = {}) {
  return {
    version: 1, board: BOARD, url: 'https://app.pullboard.dev', repository: 'owner/repository', mode: 'mirror',
    sequence: 9, cursor: 14, key: 'A'.repeat(43), snapshot: { version: 1, tables: {
      board_meta: [{ meta_key: 'board_id', meta_value: BOARD }], event: [{ event_id: 14 }],
    } },
    ...overrides,
  };
}

/** Make a valid encrypted package for another board to exercise the receiver's identity guard. */
async function sealedOtherBoardPackage(code) {
  const { locator, secret } = parsePairingCode(code);
  const value = bundle({ board: OTHER_BOARD, snapshot: { version: 1, tables: {
    board_meta: [{ meta_key: 'board_id', meta_value: OTHER_BOARD }], event: [{ event_id: 14 }],
  } } });
  const key = await webcrypto.subtle.importKey('raw', secret, 'AES-GCM', false, ['encrypt']);
  const iv = randomBytes(12);
  const aad = new TextEncoder().encode(JSON.stringify(['pullboard-pairing', 1, locator]));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, plaintext);
  return Buffer.concat([iv, Buffer.from(ciphertext)]).toString('base64url');
}

test('cli.journeys-relay-pairing.client-seals-board-key-and-native: [H15,H17] client seals board key and native snapshot under a one-time code the relay cannot read', async () => {
  const issued = createPairingCode(BOARD);
  assert.match(issued.locator, /^[A-Za-z0-9_-]{22}$/);
  assert.match(issued.secret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(parsePairingCode(issued.code).locator, issued.locator);
  assert.equal(parsePairingCode(issued.code).board, BOARD);
  const sealed = await sealPairingBundle(issued.code, bundle());
  assert.match(sealed, /^[A-Za-z0-9_-]+$/);
  assert.ok(!sealed.includes(issued.secret), 'the relay envelope does not contain the human-held code secret');
  assert.ok(!sealed.includes(bundle().key), 'the relay envelope does not contain the board key as readable text');
  assert.deepEqual(await openPairingBundle(issued.code, sealed), bundle());

  const ordered = bundle({ mode: 'ordered', sequence: 14, snapshot: { version: 1, tables: {
    board_meta: [
      { meta_key: 'board_id', meta_value: BOARD },
      { meta_key: 'relay_applied_sequence', meta_value: '14' },
      { meta_key: 'relay_engine_version', meta_value: String(ENGINE_VERSION) },
    ],
    event: [{ event_id: 14 }],
  } } });
  assert.deepEqual(await openPairingBundle(issued.code, await sealPairingBundle(issued.code, ordered)), ordered,
    'ordered pairing binds the native checkpoint to the acknowledged relay sequence');
  const futureEngine = bundle({ mode: 'ordered', sequence: 14, snapshot: { version: 1, tables: {
    board_meta: [
      { meta_key: 'board_id', meta_value: BOARD },
      { meta_key: 'relay_applied_sequence', meta_value: '14' },
      { meta_key: 'relay_engine_version', meta_value: String(ENGINE_VERSION + 1) },
    ],
    event: [{ event_id: 14 }],
  } } });
  await assert.rejects(sealPairingBundle(issued.code, futureEngine), { code: 'PAIR_PACKAGE' },
    'pairing refuses a checkpoint from a future relay engine');

  const tampered = sealed.slice(0, -1) + (sealed.endsWith('A') ? 'B' : 'A');
  await assert.rejects(openPairingBundle(issued.code, tampered), { code: 'PAIR_CODE_INVALID' });
  const wrong = createPairingCode(BOARD);
  await assert.rejects(openPairingBundle(wrong.code, sealed), { code: 'PAIR_CODE_INVALID' });
  const wrongBoardBundle = bundle({ board: OTHER_BOARD, snapshot: { version: 1, tables: {
    board_meta: [{ meta_key: 'board_id', meta_value: OTHER_BOARD }], event: [{ event_id: 14 }],
  } } });
  await assert.rejects(sealPairingBundle(issued.code, wrongBoardBundle), { code: 'PAIR_PACKAGE' },
    'the linked client will not seal a snapshot for a different board');
  await assert.rejects(openPairingBundle(issued.code, await sealedOtherBoardPackage(issued.code)), { code: 'PAIR_PACKAGE' },
    'the joining client rejects a valid encrypted package for a different board');
});

test('cli.journeys-relay-pairing.package-validation-excludes-sender-credentials-and: [H15,H17] package validation excludes sender credentials and validates relay and board identity', async () => {
  const { code } = createPairingCode(BOARD);
  for (const invalid of [
    { ...bundle(), token: 'ps_' + 'x'.repeat(43) },
    bundle({ board: '../outside' }),
    bundle({ repository: 'owner' }),
    bundle({ url: 'https://user:secret@example.test' }),
    bundle({ sequence: -1 }),
    bundle({ cursor: 1.5 }),
    bundle({ key: 'x'.repeat(42) }),
    bundle({ snapshot: { version: 2, tables: {} } }),
    bundle({ mode: 'ordered' }),
    bundle({ mode: 'ordered', sequence: 14, snapshot: { version: 1, tables: {
      board_meta: [{ meta_key: 'board_id', meta_value: BOARD }, { meta_key: 'relay_applied_sequence', meta_value: '14' }, { meta_key: 'relay_engine_version', meta_value: String(ENGINE_VERSION) }],
      event: [{ event_id: 13 }],
    } } }),
  ]) {
    await assert.rejects(sealPairingBundle(code, invalid), { code: 'PAIR_PACKAGE' });
  }
  const oversized = bundle({ snapshot: { version: 1, tables: {
    board_meta: [{ meta_key: 'board_id', meta_value: BOARD }], event: [{ event_id: 14 }], marker: [{ value: randomBytes(PAIR_PACKAGE_BYTES + 1_000_000).toString('base64') }],
  } } });
  await assert.rejects(sealPairingBundle(code, oversized), { code: 'PAIR_PACKAGE_SIZE' });
  for (const invalid of ['', 'abc', 'x'.repeat(98), BOARD + '.A'.repeat(22) + '.B'.repeat(43), null]) {
    assert.throws(() => parsePairingCode(invalid), { code: 'PAIR_CODE_INVALID' });
  }
});

test('cli.journeys-relay-pairing.relay-pairing-envelopes-expire-after-ten: [H15,H17] relay pairing envelopes expire after ten minutes and are consumed exactly once', () => {
  let now = 1_800_000_000_000;
  const store = createPairingStore({ now: () => now, maxCodes: 2 });
  const first = createPairingCode(BOARD);
  const firstEnvelope = 'A'.repeat(60);
  assert.deepEqual(store.publish(BOARD, first.locator, firstEnvelope), { expiresIn: 600 });
  assert.deepEqual(store.consume(BOARD, first.locator), { sealed: firstEnvelope });
  assert.throws(() => store.consume(BOARD, first.locator), { code: 'PAIR_CODE_USED' });
  assert.equal(store.size(), 1, 'the store retains a small tombstone so reuse has a precise refusal');

  const expired = createPairingCode(BOARD);
  store.publish(BOARD, expired.locator, 'B'.repeat(60));
  now += 600_000;
  assert.throws(() => store.consume(BOARD, expired.locator), { code: 'PAIR_CODE_EXPIRED' });
  assert.throws(() => store.consume(BOARD, 'C'.repeat(22)), { code: 'PAIR_CODE_UNKNOWN' });
  now += 600_000;
  assert.equal(store.size(), 0, 'expired and used tombstones are eventually pruned');
});

test('cli.journeys-relay-pairing.a-pairing-code-cannot-be-consumed: [H15,H17] a pairing code cannot be consumed as another board', () => {
  const store = createPairingStore();
  const issued = createPairingCode(BOARD);
  const opaque = 'A'.repeat(60);
  store.publish(BOARD, issued.locator, opaque);

  assert.throws(() => store.consume(OTHER_BOARD, issued.locator), { code: 'PAIR_CODE_INVALID' },
    'the relay record is bound to the board that published the code');
  assert.deepEqual(store.consume(BOARD, issued.locator), { sealed: opaque },
    'a mismatched-board attempt does not spend the original code');
});

test('cli.journeys-relay-pairing.relay-refuses-malformed-duplicate-and-over: [H15,H17] relay refuses malformed, duplicate and over-capacity pairing envelopes', () => {
  const store = createPairingStore({ maxCodes: 1 });
  const first = createPairingCode(BOARD);
  assert.throws(() => store.publish(BOARD, first.locator, 'not base64!'), { code: 'PAIR_PACKAGE' });
  store.publish(BOARD, first.locator, 'A'.repeat(60));
  assert.throws(() => store.publish(BOARD, first.locator, 'A'.repeat(60)), { code: 'PAIR_EXISTS' });
  const second = createPairingCode(BOARD);
  assert.throws(() => store.publish(BOARD, second.locator, 'B'.repeat(60)), { code: 'PAIR_BUSY' });
  assert.throws(() => createPairingStore({ ttl: 1 }), { code: 'PAIR_CONFIG' });
});
