/**
 * Private device key persistence and refusals [H1,H15,H17].
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { decodeBoardKey, encodeBoardKey, generateBoardKey, seal, unseal } from '../src/seal.js';
import { forgetBoardKey, readBoardKey, storeBoardKey } from '../src/relay-key.js';

/**
 * Give one test a private home and a PATH with no keychain executable, forcing the documented file fallback.
 * @param {import('node:test').TestContext} t
 * @returns {{ home: string, pullboardHome: string, keyDirectory: string }}
 */
function privateFallback(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-relay-key-'));
  const home = join(root, 'home');
  const pullboardHome = join(home, '.pullboard');
  const noCommands = join(root, 'empty-bin');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(noCommands, { mode: 0o700 });
  chmodSync(home, 0o700);
  chmodSync(noCommands, 0o700);
  const prior = Object.fromEntries(['HOME', 'PULLBOARD_HOME', 'PULLBOARD_RELAY_KEY', 'PATH'].map((name) => [name, process.env[name]]));
  process.env.HOME = home;
  process.env.PULLBOARD_HOME = pullboardHome;
  delete process.env.PULLBOARD_RELAY_KEY;
  process.env.PATH = noCommands;
  t.after(() => {
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { home, pullboardHome, keyDirectory: join(pullboardHome, 'relay-keys') };
}

test('file fallback stores a generated board key privately and reads it independently of keyRef [H1,H15,H17]', async (t) => {
  const box = privateFallback(t);
  const boardId = 'a'.repeat(32);
  const raw = await generateBoardKey();
  assert.equal(raw.byteLength, 32);

  const keyRef = await storeBoardKey(boardId, raw);
  assert.equal(typeof keyRef, 'string', 'store returns a descriptive reference, not a required read handle');
  assert.deepEqual(await readBoardKey(boardId), raw, 'the board id retrieves the same 256-bit key');

  const directory = statSync(box.keyDirectory);
  const keyFile = join(box.keyDirectory, `${boardId}.key`);
  const file = statSync(keyFile);
  assert.equal(directory.mode & 0o777, 0o700, 'the fallback key directory is private to its owner');
  assert.equal(file.mode & 0o777, 0o600, 'the fallback key file is readable and writable only by its owner');
  assert.ok(file.isFile());
  assert.ok(readFileSync(keyFile).length > 0, 'a durable local key representation was written');

  const binding = { boardId, kind: 'snapshot', sequence: 0 };
  const plaintext = new TextEncoder().encode('sealed board snapshot');
  const ciphertext = await seal(raw, plaintext, binding);
  assert.deepEqual(await unseal(await readBoardKey(boardId), ciphertext, binding), plaintext,
    'the stored key opens a real RFC 0004 sealed record');
  await assert.rejects(unseal(await generateBoardKey(), ciphertext, binding), { code: 'SEAL_AUTH_FAILED' },
    'a different device key cannot open this board record');
});

test('fallback refuses missing or wrong board identities, invalid/corrupt keys, and forget removes only that key [H1,H15,H17]', async (t) => {
  const box = privateFallback(t);
  const boardId = 'b'.repeat(32);
  const otherBoardId = 'c'.repeat(32);
  const raw = await generateBoardKey();
  assert.throws(() => readBoardKey(boardId), { code: 'RELAY_KEY_MISSING' });
  assert.throws(() => storeBoardKey('../outside', raw), { code: 'BAD_BOARD' },
    'a board id cannot escape the private key directory');
  assert.throws(() => storeBoardKey(boardId, raw.slice(1)), { code: 'SEAL_KEY' },
    'the fallback accepts only a full generated 32-byte key');

  await storeBoardKey(boardId, raw);
  assert.throws(() => readBoardKey(otherBoardId), { code: 'RELAY_KEY_MISSING' },
    'a key stored for one persistent board id is not returned for another');
  const corrupt = join(box.keyDirectory, `${boardId}.key`);
  writeFileSync(corrupt, Buffer.from('corrupt non-key data'), { mode: 0o600 });
  assert.throws(() => readBoardKey(boardId), { code: 'SEAL_KEY' },
    'corrupt persisted key material is refused');

  await forgetBoardKey(boardId);
  assert.equal(existsSync(corrupt), false, 'forget removes the local key file');
  assert.throws(() => readBoardKey(boardId), { code: 'RELAY_KEY_MISSING' });
});

test('PULLBOARD_RELAY_KEY is a canonical device-only fallback when no stored key exists [H1,H15,H17]', async (t) => {
  const box = privateFallback(t);
  const boardId = 'd'.repeat(32);
  const raw = await generateBoardKey();
  const encoded = encodeBoardKey(raw);

  process.env.PULLBOARD_RELAY_KEY = encoded;
  assert.deepEqual(readBoardKey(boardId), raw, 'the local environment key opens the same board key');
  assert.equal(existsSync(join(box.keyDirectory, `${boardId}.key`)), false, 'reading the environment fallback does not persist another copy');
  assert.deepEqual(decodeBoardKey(process.env.PULLBOARD_RELAY_KEY), raw, 'the accepted representation is canonical unpadded base64url');

  process.env.PULLBOARD_RELAY_KEY = `${encoded}=`;
  let refusal;
  assert.throws(() => readBoardKey(boardId), (error) => {
    refusal = error;
    return error.code === 'SEAL_KEY';
  }, 'padding aliases are refused instead of silently normalized');
  assert.equal(refusal.message.includes(encoded), false, 'a malformed environment secret is never echoed in the refusal');
});
