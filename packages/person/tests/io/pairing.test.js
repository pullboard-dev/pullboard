/** A pairing package gzips before sealing, so an export over the sealed limit still pairs, and an inflate bomb is refused [H15,H17,C7]. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { createPairingCode } from '../../src/io/pairing.js';
import { openPairingBundle } from '../../src/io/pairing.js';
import { parsePairingCode } from '../../src/io/pairing.js';
import { sealPairingBundle } from '../../src/io/pairing.js';
import { PAIR_PACKAGE_BYTES } from '../../src/io/pairing/limit.js';

const BOARD = '0123456789abcdef0123456789abcdef';

/** A valid native bundle whose snapshot carries one extra table of the given text. */
function bundle(filler) {
  return {
    version: 1, board: BOARD, url: 'https://relay.example', repository: 'owner/repo', mode: 'mirror', sequence: 0, cursor: 0,
    key: randomBytes(32).toString('base64url'),
    snapshot: { version: 1, tables: { board_meta: [{ meta_key: 'board_id', meta_value: BOARD }], event: [], filler: [filler] } },
  };
}

/** Seal bytes exactly as the opener expects, so the test can build packages the sealer would never make. */
async function sealRaw(code, bytes) {
  const { locator, secret } = parsePairingCode(code);
  const iv = randomBytes(12);
  const key = await webcrypto.subtle.importKey('raw', secret, 'AES-GCM', false, ['encrypt']);
  const aad = new TextEncoder().encode(JSON.stringify(['pullboard-pairing', 1, locator]));
  const cipher = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, bytes));
  return Buffer.concat([iv, cipher]).toString('base64url');
}

test('person.pairing.gzipped-bundle-over-limit-round-trips: clause 1: a bundle whose JSON is over 90,000,000 bytes but compresses under it seals and opens [H15,H17,C7]', { timeout: 120_000 }, async () => {
  const { code } = createPairingCode(BOARD);
  const value = bundle('x'.repeat(PAIR_PACKAGE_BYTES + 1_000_000));
  assert.ok(JSON.stringify(value).length > PAIR_PACKAGE_BYTES, 'the JSON is over the sealed limit');
  const sealed = await sealPairingBundle(code, value);
  assert.deepEqual(await openPairingBundle(code, sealed), value);
});

test('person.pairing.incompressible-refused-and-plain-json-opens: clause 2: a bundle whose gzip output is still over the limit is refused PAIR_PACKAGE_SIZE, and a plain-JSON package from before gzip still opens [H15,H17,C7]', { timeout: 300_000 }, async () => {
  const { code } = createPairingCode(BOARD);
  const dense = bundle(randomBytes(PAIR_PACKAGE_BYTES + 12_000_000).toString('base64'));
  await assert.rejects(() => sealPairingBundle(code, dense), (error) => error.code === 'PAIR_PACKAGE_SIZE');
  const small = bundle('older package');
  const plain = await sealRaw(code, new TextEncoder().encode(JSON.stringify(small)));
  assert.deepEqual(await openPairingBundle(code, plain), small);
});

test('person.pairing.gzip-bomb-refused: clause 3: a gzip package that inflates past 400,000,000 bytes is refused PAIR_PACKAGE_SIZE on open [H15,H17,C7]', { timeout: 120_000 }, async () => {
  const { code } = createPairingCode(BOARD);
  const bomb = gzipSync(Buffer.alloc(400_000_001));
  assert.ok(bomb.length < PAIR_PACKAGE_BYTES, 'the bomb is small enough to be sealed and sent');
  const sealed = await sealRaw(code, bomb);
  await assert.rejects(() => openPairingBundle(code, sealed), (error) => error.code === 'PAIR_PACKAGE_SIZE');
});
