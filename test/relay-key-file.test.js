/** Owner-only relay key files and legacy keychain migration [H15,H17]. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { relayClientFixture } from './relay-client-fixture.js';

/** Install an isolated `security` command without consulting the host keychain. */
function securityStandIn(box) {
  const store = join(box.env.PULLBOARD_HOME, 'legacy-keychain-entry');
  const security = join(box.env.PATH, 'security');
  const script = '#!' + process.execPath + '\n' + [
    "const { existsSync, readFileSync, rmSync } = require('node:fs');",
    'const command = process.argv[2];',
    "if (['list-keychains', 'search'].includes(command)) process.exit(0);",
    "if (['find-generic-password', 'lookup'].includes(command)) {",
    "  if (process.env.SECURITY_MODE !== 'available') process.exit(1);",
    "  if (!existsSync(process.env.KEYCHAIN_STORE)) process.exit(command === 'lookup' ? 1 : 44);",
    "  process.stdout.write(readFileSync(process.env.KEYCHAIN_STORE));",
    "} else if (['delete-generic-password', 'clear'].includes(command)) rmSync(process.env.KEYCHAIN_STORE, { force: true });",
    'else process.exit(1);',
  ].join('\n');
  for (const executable of [security, join(box.env.PATH, 'secret-tool')]) {
    writeFileSync(executable, script, { mode: 0o700 });
    chmodSync(executable, 0o700);
  }
  box.env.KEYCHAIN_STORE = store;
  box.env.SECURITY_MODE = 'locked';
  return store;
}

test('owner-only key file links and reads with a locked keychain, migrates once, and supports the environment key [H15,H17]', async (t) => {
  const box = await relayClientFixture(t);
  const legacyStore = securityStandIn(box);

  const linked = await box.cli('relay', 'on', '--url', box.origin);
  assert.equal(linked.code, 0,
    'relay on succeeds when the available security command reports a locked keychain');
  assert.ok(existsSync(box.keyFile), 'relay on writes the board key under the private pullboard home');
  assert.equal(statSync(join(box.env.PULLBOARD_HOME, 'relay-keys')).mode & 0o777, 0o700,
    'the key directory is owner-only');
  assert.equal(statSync(box.keyFile).mode & 0o777, 0o600,
    'the key file is owner-readable and owner-writable only');
  assert.equal((await box.cli('relay')).code, 0,
    'a subsequent linked read does not need to unlock the keychain');

  const encoded = readFileSync(box.keyFile, 'utf8').trim();
  assert.equal(linked.document.link.endsWith('&key=' + encoded), true, 'the intended pairing field carries the generated key');
  const { link: pairingLink, ...publicLinkResult } = linked.document;
  assert.equal(JSON.stringify(publicLinkResult).includes(encoded), false, 'the JSON result has no key outside its pairing field');
  for (const args of [['status'], ['show', '1'], ['relay'], ['show', '999999']]) {
    const result = await box.cli(...args);
    assert.equal(result.code, args[1] === '999999' ? 1 : 0, 'ordinary reads or their typed refusal complete');
    assert.equal(JSON.stringify(result.document).includes(encoded), false, 'ordinary status, show, relay and refusals never contain the board key');
  }
  const text = await box.script(`
    import { main } from ${JSON.stringify(box.mainURL)};
    import { readFileSync } from 'node:fs';
    const key = readFileSync(${JSON.stringify(box.keyFile)}, 'utf8').trim();
    let output = '', errors = '';
    const streams = { cwd: ${JSON.stringify(box.root)},
      stdout: { write: part => { output += part; } }, stderr: { write: part => { errors += part; } } };
    const linkedCode = await main(['relay', 'on', '--url', ${JSON.stringify(box.origin)}], streams);
    const carriers = output.split('\\n').filter(line => line.includes(key));
    const pairingOnly = carriers.length === 1 && carriers[0].startsWith('https://app.pullboard.dev/#board=') && carriers[0].endsWith('&key=' + key);
    output = '';
    const statusCode = await main(['status'], streams);
    const refusalCode = await main(['show', '999999'], streams);
    console.log(JSON.stringify({ version: 1, linkedCode, statusCode, refusalCode, pairingOnly,
      ordinaryLeak: output.includes(key), errorLeak: errors.includes(key) }));
  `);
  assert.equal(text.code, 0, 'the real text-output probe completes without printing its captured key');
  assert.deepEqual(text.document, { version: 1, linkedCode: 0, statusCode: 0, refusalCode: 1,
    pairingOnly: true, ordinaryLeak: false, errorLeak: false }, 'text output shows the key once in its pairing link and nowhere in ordinary output or errors');
  box.env.PULLBOARD_RELAY_KEY = encoded;
  assert.equal((await box.cli('status')).code, 0, 'matching file and environment keys remain usable');
  const wrongEnvironmentKey = randomBytes(32).toString('base64url');
  box.env.PULLBOARD_RELAY_KEY = wrongEnvironmentKey;
  const callsBeforeMismatch = box.calls.length;
  const mismatch = await box.cli('add', box.lane, 'Refused mismatched key move');
  assert.equal(mismatch.code, 1, 'a move refuses conflicting device key sources');
  assert.equal(mismatch.document.error.code, 'RELAY_KEY_FILE_ENV_MISMATCH');
  assert.match(mismatch.document.error.message, /PULLBOARD_RELAY_KEY.*file.*unset/u);
  for (const key of [encoded, wrongEnvironmentKey]) {
    assert.equal(JSON.stringify(mismatch.document).includes(key), false, 'the mismatch never exposes either key');
  }
  assert.equal(box.calls.length, callsBeforeMismatch, 'a mismatched key never reaches the relay');
  box.env.PULLBOARD_RELAY_KEY = encoded;
  writeFileSync(legacyStore, encoded, { mode: 0o600 });
  rmSync(box.keyFile);
  box.env.SECURITY_MODE = 'available';
  const legacyLink = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  legacyLink.keyStorage = 'keychain';
  writeFileSync(box.linkFile, JSON.stringify(legacyLink), { mode: 0o600 });
  assert.equal((await box.cli('relay')).code, 0,
    'an existing keychain key still opens the linked board');
  assert.ok(existsSync(box.keyFile), 'legacy migration runs before the matching environment fallback');
  assert.equal(readFileSync(box.keyFile, 'utf8').trim(), encoded,
    'the legacy keychain key is copied into the owner-only file');
  assert.equal(existsSync(legacyStore), false, 'the old keychain copy is removed after migration');
  delete box.env.PULLBOARD_RELAY_KEY;
  box.env.SECURITY_MODE = 'locked';
  assert.equal((await box.cli('relay')).code, 0,
    'reads continue after migration when the keychain is locked again');
  assert.equal((await box.cli('relay', 'off')).code, 0,
    'unlink uses the migrated file even when legacy metadata still says keychain');
  assert.equal(existsSync(box.keyFile), false, 'unlink forgets the migrated owner-only file');
  assert.equal((await box.cli('relay', 'on', '--url', box.origin)).code, 0,
    'the board can link again while the keychain remains locked');

  const envKey = readFileSync(box.keyFile, 'utf8').trim();
  rmSync(box.keyFile);
  box.env.PULLBOARD_RELAY_KEY = envKey;
  assert.equal((await box.cli('relay')).code, 0,
    'PULLBOARD_RELAY_KEY opens the linked board without a key file');
  const moves = box.calls.filter(call => call.method === 'POST' && call.path.endsWith('/moves')).length;
  assert.equal((await box.cli('add', box.lane, 'Environment-only key move')).code, 0,
    'PULLBOARD_RELAY_KEY seals and sends a real move without a key file');
  assert.ok(box.calls.filter(call => call.method === 'POST' && call.path.endsWith('/moves')).length > moves,
    'the environment-only command reaches the real relay move endpoint');
  assert.equal(existsSync(box.keyFile), false, 'the environment key is not copied to a file');
});
