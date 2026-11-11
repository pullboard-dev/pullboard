/** Owner-only relay key files and legacy keychain migration, run through the link door with no CLI [H15,H17,C7]. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { constants } from 'node:fs';
import { copyFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { delimiter } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { relayDirectFixture } from './fixtures/relay-direct-fixture.js';
import { relayOff } from '../../../packages/link/index.js';
import { relayOperation } from '../../../packages/link/index.js';
import { syncRelay } from '../../../packages/link/index.js';
import { ENGINE_VERSION } from '../../../packages/state/index.js';

/**
 * Copy this Node into a folder whose name has a space, as on a machine where Node lives under such a path (#865).
 * A shebang cannot hold that path, so every wrapper below must start Node through the shell instead.
 */
function nodeAtSpacedPath() {
  const folder = join(process.env.PULLBOARD_HOME, 'node with spaces');
  mkdirSync(folder, { recursive: true });
  const node = join(folder, 'node');
  copyFileSync(realpathSync(process.execPath), node, constants.COPYFILE_FICLONE);
  chmodSync(node, 0o700);
  return node;
}

/** Put an isolated `security` command first on this process's PATH without consulting the host keychain; the test's end restores the environment. */
function securityStandIn(t) {
  const home = process.env.PULLBOARD_HOME;
  const saved = Object.fromEntries(['PATH', 'KEYCHAIN_STORE', 'SECURITY_MODE'].map(name => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const store = join(home, 'legacy-keychain-entry');
  const privateBin = join(home, 'path');
  mkdirSync(privateBin, { recursive: true, mode: 0o700 });
  const program = join(home, 'security stand-in.cjs');
  const wrapper = `#!/bin/sh\nexec ${JSON.stringify(nodeAtSpacedPath())} ${JSON.stringify(program)} "$@"\n`;
  const script = [
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
  writeFileSync(program, script, { mode: 0o600 });
  for (const executable of [join(privateBin, 'security'), join(privateBin, 'secret-tool')]) {
    writeFileSync(executable, wrapper, { mode: 0o700 });
    chmodSync(executable, 0o700);
  }
  process.env.PATH = privateBin + delimiter + saved.PATH;
  process.env.KEYCHAIN_STORE = store;
  process.env.SECURITY_MODE = 'locked';
  return store;
}

test('owner-only key file links and reads with a locked keychain, migrates once, and supports the environment key [H15,H17]', async (t) => {
  const box = await relayDirectFixture(t);
  const home = process.env.PULLBOARD_HOME;
  const legacyStore = securityStandIn(t);
  /** A coordinator's add, sent as a linked move through the link door. */
  const addMove = title => relayOperation(box.root, 'addItem', [{ by: 'coordinator', lane: 'web', title }], box.io);

  const linked = await box.link();
  assert.match(linked.board, /^[0-9a-f]{32}$/u,
    'relay on succeeds when the available security command reports a locked keychain');
  const keyFile = join(home, 'relay-keys', linked.board + '.key');
  assert.ok(existsSync(keyFile), 'relay on writes the board key under the private pullboard home');
  assert.equal(statSync(join(home, 'relay-keys')).mode & 0o777, 0o700,
    'the key directory is owner-only');
  assert.equal(statSync(keyFile).mode & 0o777, 0o600,
    'the key file is owner-readable and owner-writable only');
  await assert.doesNotReject(syncRelay(box.root, box.io),
    'a subsequent linked read does not need to unlock the keychain');

  const encoded = readFileSync(keyFile, 'utf8').trim();
  process.env.PULLBOARD_RELAY_KEY = encoded;
  await assert.doesNotReject(syncRelay(box.root, box.io), 'matching file and environment keys remain usable');
  const wrongEnvironmentKey = randomBytes(32).toString('base64url');
  process.env.PULLBOARD_RELAY_KEY = wrongEnvironmentKey;
  const callsBeforeMismatch = box.server.calls.length;
  await assert.rejects(addMove('Refused mismatched key move'), error => {
    assert.equal(error.code, 'RELAY_KEY_FILE_ENV_MISMATCH', 'a move refuses conflicting device key sources');
    assert.match(error.message, /PULLBOARD_RELAY_KEY.*file.*unset/u);
    for (const key of [encoded, wrongEnvironmentKey]) {
      assert.equal(error.message.includes(key), false, 'the mismatch never exposes either key');
    }
    return true;
  });
  assert.equal(box.server.calls.length, callsBeforeMismatch, 'a mismatched key never reaches the relay');
  process.env.PULLBOARD_RELAY_KEY = encoded;
  writeFileSync(legacyStore, encoded, { mode: 0o600 });
  rmSync(keyFile);
  process.env.SECURITY_MODE = 'available';
  const legacyLink = box.readLink();
  legacyLink.keyStorage = 'keychain';
  writeFileSync(box.linkFile, JSON.stringify(legacyLink), { mode: 0o600 });
  await assert.doesNotReject(syncRelay(box.root, box.io), 'an existing keychain key still opens the linked board');
  assert.ok(existsSync(keyFile), 'legacy migration runs before the matching environment fallback');
  assert.equal(readFileSync(keyFile, 'utf8').trim(), encoded,
    'the legacy keychain key is copied into the owner-only file');
  assert.equal(existsSync(legacyStore), false, 'the old keychain copy is removed after migration');
  delete process.env.PULLBOARD_RELAY_KEY;
  process.env.SECURITY_MODE = 'locked';
  await assert.doesNotReject(syncRelay(box.root, box.io),
    'reads continue after migration when the keychain is locked again');
  await relayOff(box.root, box.io);
  assert.equal(existsSync(keyFile), false, 'unlink forgets the migrated owner-only file');
  const phone = await box.server.phoneSession();
  const deleted = await fetch(box.origin + '/api/v1/boards/' + legacyLink.board, {
    method: 'DELETE', headers: { authorization: 'Bearer ' + phone.token, 'x-pullboard-engine': String(ENGINE_VERSION) },
  });
  assert.equal(deleted.status, 200, 'the phone explicitly removes the old relay copy before linking with a new key');
  const relinked = await box.link();
  assert.match(relinked.board, /^[0-9a-f]{32}$/u, 'the board can link again while the keychain remains locked');
  assert.notEqual(relinked.board, legacyLink.board, 'explicit OFF relinks a fresh board epoch');
  const currentKeyFile = join(home, 'relay-keys', relinked.board + '.key');
  assert.equal(existsSync(keyFile), false, 'the previous epoch key stays forgotten');
  assert.equal(statSync(currentKeyFile).mode & 0o777, 0o600, 'the new epoch key file is owner-only too');
  const envKey = readFileSync(currentKeyFile, 'utf8').trim();
  assert.notEqual(envKey, encoded, 'the fresh epoch does not reuse the old board key');
  rmSync(currentKeyFile);
  process.env.PULLBOARD_RELAY_KEY = envKey;
  await assert.doesNotReject(syncRelay(box.root, box.io),
    'PULLBOARD_RELAY_KEY opens the linked board without a key file');
  const moves = box.server.calls.filter(call => call.method === 'POST' && call.path.endsWith('/moves')).length;
  await addMove('Environment-only key move');
  assert.ok(box.server.calls.filter(call => call.method === 'POST' && call.path.endsWith('/moves')).length > moves,
    'the environment-only command reaches the real relay move endpoint');
  assert.equal(existsSync(currentKeyFile), false, 'the environment key is not copied to a file');
});
