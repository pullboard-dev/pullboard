/** Explicit relinking creates a new sealed epoch without accepting the forgotten key [H15,H17]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  decodeBoardKey,
  seal,
  unseal,
} from '../../../../packages/kernel/index.js';
import { relayClientFixture } from '../../tests/fixtures/relay/client.js';
import { assertPersonUnlinkHistory } from '../../tests/fixtures/relay/exclusion.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';

test('a relink after relay off seals moves with the new key [H15,H17]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const oldLink = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const oldKey = decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim());
  assert.equal((await box.cli('shout', 'all', 'before explicit unlink')).code, 0);
  const beforeOff = (await box.cli('export')).document;
  assert.equal((await box.cli('relay', 'off')).code, 0);
  assertPersonUnlinkHistory((await box.cli('export')).document.tables, beforeOff.tables);
  assert.equal((await box.cli('relay', 'on', '--url', box.origin)).code, 0);
  const linked = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  assert.notEqual(linked.board, oldLink.board, 'forgetting the key requires a fresh remote board');
  const key = decodeBoardKey(readFileSync(join(box.env.PULLBOARD_HOME, 'relay-keys', linked.board + '.key'), 'utf8').trim());
  assert.equal((await box.cli('shout', 'all', 'after explicit relink')).code, 0);
  const move = box.moveAcks.at(-1);
  const binding = { boardId: linked.board, kind: 'move', sequence: move.event_id };
  const opened = await unseal(key, Buffer.from(move.sealed, 'base64url'), binding);
  assert.equal(JSON.parse(new TextDecoder().decode(opened)).operation, 'shout');
  await assert.rejects(unseal(oldKey, Buffer.from(move.sealed, 'base64url'), binding), { code: 'SEAL_AUTH_FAILED' });
  const stale = await seal(oldKey, opened, binding);
  await assert.rejects(unseal(key, stale, binding), { code: 'SEAL_AUTH_FAILED' },
    'even with the new board and sequence binding, a move sealed with the forgotten key is refused');
  const exported = (await box.cli('export')).document;
  assert.ok(exported.tables.shout.some(row => row.shout_text === 'before explicit unlink'));
  assert.ok(exported.tables.shout.some(row => row.shout_text === 'after explicit relink'));
  const response = await fetch(box.origin + '/api/v2/boards/' + oldLink.board + '/state', {
    headers: { authorization: 'Bearer ' + (await box.phoneSession()).token, 'x-pullboard-engine': String(ENGINE_VERSION) },
  });
  assert.equal(response.status, 200, 'the old remote copy remains until the person deletes it');
});

test('a durable pending relink retries the same fresh identity and key [H15,H17]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const previous = JSON.parse(readFileSync(box.linkFile, 'utf8')).board;
  assert.equal((await box.cli('relay', 'off')).code, 0);
  box.refuseBoardLinks(true);
  assert.notEqual((await box.cli('relay', 'on', '--url', box.origin)).code, 0);
  const pending = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  assert.notEqual(pending.board, previous);
  assert.equal(pending.linkPending, true);
  const keyFile = join(box.env.PULLBOARD_HOME, 'relay-keys', pending.board + '.key');
  const key = readFileSync(keyFile, 'utf8');
  box.refuseBoardLinks(false);
  const retry = await box.cli('relay', 'on', '--url', box.origin);
  assert.equal(retry.code, 0);
  assert.equal(JSON.parse(readFileSync(box.linkFile, 'utf8')).board, pending.board);
  assert.equal(readFileSync(keyFile, 'utf8') === key, true, 'retry retains the exact saved device key');
  assert.match(retry.document.notice, /old remote copy stays/u);
  assert.equal((await box.cli('relay', 'on', '--url', box.origin)).document.notice, undefined,
    'the old-copy notice is not repeated after the successful retry');
});

test('relink snapshots actual local queued effects and retains old encrypted obligations separately [H15,H17,B26]', async t => {
  const box = await relayClientFixture(t);
  const configFile = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, relay: { outbox: true } }) + '\n');
  const cli = fileURLToPath(new URL('../../pullboard.js', import.meta.url));
  writeFileSync(join(box.env.PATH, 'pullboard'), `#!/bin/sh\nexec node "${cli}" "$@"\n`, { mode: 0o700 });
  const draft = await box.cli('spec', 'draft', 'Queue local relay moves while the relay is offline');
  assert.equal(draft.code, 0);
  runFixtureGit(['add', 'pullboard.json', config.spec ?? 'SPEC.md'], { cwd: box.root, env: box.env });
  runFixtureGit(['commit', '-q', '-m', 'chore(config): queue relay moves while offline [' + draft.document.id + ']'],
    { cwd: box.root, env: box.env });
  await box.link();
  const old = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  await box.stopRelay();
  assert.equal((await box.cli('shout', 'all', 'actual locally queued effect')).code, 0);
  const directory = join(box.root, '.git', 'pullboard');
  const outbox = readFileSync(join(directory, 'relay-outbox.sealed'));
  assert.equal((await box.cli('relay', 'off')).code, 0);
  assert.equal(existsSync(join(directory, 'relay-outbox.sealed')), false);
  const archived = readdirSync(directory).find(name => name.startsWith('relay-outbox-' + old.board + '-') && name.endsWith('.sealed'));
  assert.ok(archived);
  assert.equal(readFileSync(join(directory, archived)).equals(outbox), true,
    'old obligations retain their exact ciphertext, not a new-key re-encryption or success receipt');
  const context = JSON.parse(readFileSync(join(directory, archived.replace(/\.sealed$/u, '.json')), 'utf8'));
  assert.equal(context.board, old.board);
  assert.equal(context.url, old.url);
  await box.restartRelay();
  assert.equal((await box.cli('relay', 'on', '--url', box.origin)).code, 0);
  const exported = (await box.cli('export')).document;
  assert.equal(exported.tables.shout.filter(row => row.shout_text === 'actual locally queued effect').length, 1,
    'the fresh baseline contains the native effect once, without replaying old queued moves');
  assert.equal((await box.cli('shout', 'all', 'new epoch after queued effect')).code, 0);
});

test('the native receiver refuses an old-key move on the fresh relinked board [H15,H17]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  const oldKey = decodeBoardKey(readFileSync(box.keyFile, 'utf8').trim());
  assert.equal((await box.cli('relay', 'off')).code, 0);
  assert.equal((await box.cli('relay', 'on', '--url', box.origin)).code, 0);
  assert.equal((await box.cli('shout', 'all', 'current-key receiver control')).code, 0);
  const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const key = decodeBoardKey(readFileSync(join(box.env.PULLBOARD_HOME, 'relay-keys', link.board + '.key'), 'utf8').trim());
  const prior = box.moveAcks.at(-1);
  const plain = await unseal(key, Buffer.from(prior.sealed, 'base64url'),
    { boardId: link.board, kind: 'move', sequence: prior.event_id });
  const move = JSON.parse(new TextDecoder().decode(plain));
  move.id = randomUUID();
  move.args[0].text = 'old-key move must never apply';
  const sequence = link.sequence + 1;
  const sealed = Buffer.from(await seal(oldKey, new TextEncoder().encode(JSON.stringify(move)),
    { boardId: link.board, kind: 'move', sequence })).toString('base64url');
  const response = await fetch(box.origin + '/api/v1/boards/' + link.board + '/moves', {
    method: 'POST', headers: { authorization: 'Bearer ' + link.agentTokens.coordinator.token,
      'x-pullboard-engine': String(ENGINE_VERSION), 'content-type': 'application/json' },
    body: JSON.stringify({ sequence, sealed }),
  });
  assert.equal(response.status, 200, 'the opaque relay stores a correctly authorized position without opening it');
  const exported = await box.cli('export');
  assert.equal(exported.code, 0);
  assert.equal(exported.document.tables.shout.some(row => row.shout_text === move.args[0].text), false,
    'the native receiver never applies the stale-key operation');
  const refusal = exported.document.tables.board_meta.find(row => row.meta_key === 'relay_refusal_' + sequence);
  assert.ok(refusal, 'the actual native receiver durably records the refused position');
  assert.equal(JSON.parse(refusal.meta_value).outcome.error.code, 'RELAY_SEAL');
});
