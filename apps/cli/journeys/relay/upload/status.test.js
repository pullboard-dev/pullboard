/** Real HTTP authorization, private ciphertext and accepted-snapshot recovery for size notices [H5,H15,H17]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { relayClientFixture } from "../../../tests/fixtures/relay/client.js";
import {
  decodeBoardKey,
  unseal,
} from "../../../../../packages/kernel/index.js";
import { ENGINE_VERSION } from "../../../../../packages/state/index.js";

test('a real refused upload produces only board-scoped sealed status and accepted data clears it [H5,H15,H17]', async t => {
  const box = await relayClientFixture(t);
  box.legacySnapshotApi(true);
  box.limitSnapshots(128);
  await box.link();
  const state = JSON.parse(readFileSync(box.linkFile, 'utf8'));
  const path = '/api/v1/boards/' + state.board + '/upload-status';
  const headers = { authorization: 'Bearer ' + state.token, 'x-pullboard-engine': String(ENGINE_VERSION) };
  const response = await fetch(box.origin + path, { headers });
  assert.equal(response.status, 200);
  const document = await response.json();
  assert.deepEqual(Object.keys(document.status), ['sealed'], 'the relay returns no readable name, path, size or key');
  const encodedKey = readFileSync(box.keyFile, 'utf8').trim();
  const plain = await unseal(decodeBoardKey(encodedKey), new Uint8Array(Buffer.from(document.status.sealed, 'base64url')),
    { boardId: state.board, kind: 'snapshot', sequence: 0 });
  const value = JSON.parse(new TextDecoder().decode(plain));
  assert.equal(value.sealedBytes, Buffer.from(state.snapshot.sealed, 'base64url').byteLength);
  assert.equal(value.limit, 128);
  assert.equal(value.kind, 'snapshot-size-refusal');
  assert.equal((await fetch(box.origin + path)).status, 401, 'the status is never anonymous');
  const agent = await box.auth.issueToken(state.token, { board: state.board, agent: 'size-status-reader' });
  const body = JSON.stringify(document.status);
  assert.equal((await fetch(box.origin + path, { method: 'PUT', headers: { ...headers,
    authorization: 'Bearer ' + agent.token, 'content-type': 'application/json' }, body })).status, 403,
  'an agent cannot publish a machine refusal');
  assert.equal((await fetch(box.origin + '/api/v1/boards/' + 'f'.repeat(32) + '/upload-status', { headers })).ok, false,
    'the credential cannot read another board’s status');
  assert.equal((await fetch(box.origin + path, { method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ ...document.status, limit: 128 }) })).status, 400, 'plaintext status fields are refused');
  const person = await box.phoneSession();
  assert.equal((await fetch(box.origin + path, { method: 'PUT', headers: { cookie: 'pb_session=' + person.token,
    origin: 'https://foreign.invalid', 'x-pullboard-engine': String(ENGINE_VERSION), 'content-type': 'application/json' }, body })).status, 403,
  'a foreign page cannot publish through a person cookie');
  box.limitSnapshots(null);
  box.legacySnapshotApi(false);
  assert.equal((await box.cliLocal('status')).code, 0);
  assert.equal((await (await fetch(box.origin + path, { headers })).json()).status, null,
    'accepting the actual bounded snapshot clears its stale notice');
  const late = await fetch(box.origin + path, { method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body });
  assert.equal(late.status, 200);
  assert.equal((await late.json()).recorded, false, 'a late notice cannot replace an already accepted board copy');
  assert.equal((await (await fetch(box.origin + path, { headers })).json()).status, null);
});
