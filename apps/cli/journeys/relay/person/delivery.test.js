/** Native person enrollment uses pinned roots and board-scoped machine authority [H15]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { relayClientFixture } from '../../../tests/fixtures/relay/client.js';
import {
  createPersonRoot,
  signPersonEnrollment,
} from '../../../../../packages/person/light.js';
import {
  createDeviceKeys,
  unwrapDeviceBoardKey,
} from '../../../../../packages/keys/index.js';
import { decodeBoardKey } from '../../../../../packages/kernel/index.js';
import { ENGINE_VERSION } from '../../../../../packages/state/index.js';

test('a native key holder verifies a pinned person root before delivering each granted board [H15]',
  { timeout: 180_000 }, async t => { // budget: hang ceiling for three private CLI board setups and real HTTP delivery/refusal controls.
    t.diagnostic('runtime ' + JSON.stringify({ node: process.version, sqlite: process.versions.sqlite,
      executable: process.execPath, binarySha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex') }));
    const box = await relayClientFixture(t);
    await box.link();
    const second = await box.additionalBoard('second granted board');
    const third = await box.additionalBoard('linked but ungranted board', { sharedHome: true });
    const link = JSON.parse(readFileSync(box.linkFile, 'utf8'));
    const session = await box.phoneSession();
    const root = await createPersonRoot();
    const device = await createDeviceKeys();
    const stranger = await createDeviceKeys();
    const base = '/api/v1/devices/person-enrollments';
    /** Exercise the real authenticated HTTP boundary without exposing fixture credentials in assertions. */
    async function call(path, { method = 'GET', body, machine = false } = {}) {
      const response = await fetch(box.origin + path, { method, headers: {
        ...(machine ? { authorization: 'Bearer ' + link.token } : { cookie: 'pb_session=' + session.token }),
        origin: box.origin, 'x-pullboard-engine': String(ENGINE_VERSION), 'content-type': 'application/json',
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, ...await response.json() };
    }
    /** Sign a fresh exact challenge; no private signing key enters relay transport or child arguments. */
    async function challenge(overrides = {}) {
      return await signPersonEnrollment(root.privateKey, { v: 1, account: '7', device: device.deviceId,
        publicKey: device.publicKey, origin: box.origin,
        nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
        expires: Date.now() + 600_000, grants: [link.board, second.id], ...overrides });
    }
    /** The fixture supplies only the public pin; initial person/passkey bootstrap belongs to #408. */
    async function pin(publicKey, holder = box) {
      const result = await holder.script(`
        const { updateRelayMachine } = await import(${JSON.stringify(new URL('../../../../../packages/link/index.js', import.meta.url).href)});
        updateRelayMachine(state => { state.personRoots = ${JSON.stringify(publicKey
          ? [{ account: '7', url: box.origin, origin: box.origin, publicKey }] : [])}; });
        process.stdout.write('{}');
      `);
      assert.equal(result.code, 0, 'only the private fixture public-root metadata is written');
    }
    const signed = await challenge();
    assert.equal((await call(base + '/' + signed.nonce, { method: 'POST', body: signed })).status, 200);
    const pending = await call(base, { machine: true });
    assert.equal(pending.status, 200, 'the actual board publisher can discover its pending enrollment');
    assert.equal(pending.enrollments.some(row => row.nonce === signed.nonce), true);
    assert.equal((await box.cli('relay', 'status')).code, 0);
    assert.deepEqual((await call(base + '/' + signed.nonce)).wraps, [], 'no local pin means no key release');
    await pin((await createPersonRoot()).publicKey);
    assert.equal((await box.cli('relay', 'status')).code, 0);
    assert.deepEqual((await call(base + '/' + signed.nonce)).wraps, [], 'a different pinned root cannot verify the request');
    await pin(root.publicKey);
    const raced = await box.script(`
      const {readFileSync} = await import('node:fs');
      const {deliverPersonEnrollments} = await import(${JSON.stringify(new URL('../../../../../packages/keys/index.js', import.meta.url).href)});
      const {relayDeviceRequest} = await import(${JSON.stringify(new URL('../../../../../packages/link/index.js', import.meta.url).href)});
      const {relayPersonRoot,updateRelayMachine} = await import(${JSON.stringify(new URL('../../../../../packages/link/index.js', import.meta.url).href)});
      const state = JSON.parse(readFileSync(${JSON.stringify(box.linkFile)}, 'utf8'));
      let reads = 0;
      const errors = [];
      /** Revoke the real saved pin at the second read, after authentication and wrapping. */
      function currentRoot(owner) {
        if (++reads === 2) updateRelayMachine(machine => { machine.personRoots = []; });
        return relayPersonRoot(owner);
      }
      await deliverPersonEnrollments(state, {err(message){errors.push(message);}}, relayDeviceRequest,
        {relayPersonRoot:currentRoot});
      process.stdout.write(JSON.stringify({reads,errors}));
    `);
    assert.equal(raced.code, 0, raced.stderr);
    assert.equal(raced.document.reads, 2, 'the injected caller port reads the actual pin again after wrapping');
    assert.equal(raced.document.errors.some(message => message.includes('PERSON_ENROLL_AUTH')), true);
    assert.deepEqual((await call(base + '/' + signed.nonce)).wraps, [], 'a pin revoked during wrapping releases no board key');
    await pin(root.publicKey);
    assert.equal((await box.cli('relay', 'status')).code, 0);
    const first = await call(base + '/' + signed.nonce);
    assert.deepEqual(first.wraps.map(row => row.board), [link.board], 'the first machine token releases only its board');
    const crossBoard = await call(base + '/' + signed.nonce, { method: 'PUT', machine: true,
      body: { ...first.wraps[0], board: second.id } });
    assert.equal(crossBoard.error?.code, 'TOKEN_BOARD', 'machine A cannot consume board B completion');
    await pin(root.publicKey, second);
    assert.equal((await second.cli('relay', 'status')).code, 0);
    const complete = await call(base + '/' + signed.nonce);
    assert.deepEqual(complete.wraps.map(row => row.board).sort(), [link.board, second.id].sort());
    const keys = new Map([[link.board, readFileSync(box.keyFile, 'utf8').trim()], [second.id, second.encoded]]);
    for (const row of complete.wraps) {
      const envelope = JSON.parse(Buffer.from(row.wrapped, 'base64url'));
      const opened = await unwrapDeviceBoardKey(device.privateKey, envelope,
        { board: row.board, device: device.deviceId, engine: row.engine });
      assert.equal(Buffer.from(opened).equals(Buffer.from(decodeBoardKey(keys.get(row.board)))), true,
        'the intended browser opens the actual board key');
      await assert.rejects(unwrapDeviceBoardKey(stranger.privateKey, envelope,
        { board: row.board, device: device.deviceId, engine: row.engine }), { code: 'DEVICE_WRAP_AUTH' });
    }
    assert.equal((await call(base + '/' + signed.nonce,
      { method: 'PUT', machine: true, body: first.wraps[0] })).status, 200, 'an identical active PUT is idempotent');
    const changed = await call(base + '/' + signed.nonce,
      { method: 'PUT', machine: true, body: { ...first.wraps[0], engine: ENGINE_VERSION + 1 } });
    assert.equal(changed.error?.code, 'PERSON_ENROLL_REPLAY', 'a changed completion cannot reuse the nonce-board');
    assert.equal((await call(base + '/' + signed.nonce, { method: 'POST', body: signed })).error?.code,
      'PERSON_ENROLL_REPLAY', 'POST nonce reuse is still refused');
    assert.equal((await third.cli('relay', 'status')).code, 0);
    assert.deepEqual((await call('/api/v1/devices/' + device.deviceId + '/boards')).wraps.map(row => row.board).sort(),
      [link.board, second.id].sort(), 'later sync never widens this enrollment to a third linked board');

    for (const mutation of [{ publicKey: stranger.publicKey }, { origin: 'https://foreign.invalid' },
      { grants: [link.board, second.id, third.id] }]) {
      const invalid = { ...await challenge(), ...mutation };
      assert.equal((await call(base + '/' + invalid.nonce, { method: 'POST', body: invalid })).status, 200);
      assert.equal((await box.cli('relay', 'status')).code, 0, 'an invalid public enrollment cannot block ordinary sync');
      assert.deepEqual((await call(base + '/' + invalid.nonce)).wraps, [], 'tampered signed context releases no wrap');
    }
    const wrongAccount = await challenge({ account: '8' });
    assert.equal((await call(base + '/' + wrongAccount.nonce, { method: 'POST', body: wrongAccount })).error?.code,
      'PERSON_ENROLL_ACCOUNT');
    const expired = await challenge({ expires: Date.now() - 1 });
    assert.equal((await call(base + '/' + expired.nonce, { method: 'POST', body: expired })).error?.code,
      'PERSON_ENROLL_EXPIRED');
    const mismatched = await challenge();
    assert.equal((await call(base + '/' + signed.nonce, { method: 'POST', body: mismatched })).error?.code,
      'PERSON_ENROLL_AUTH', 'an enrollment cannot be uploaded at another nonce address');
    await box.restartRelay();
    assert.equal((await call(base + '/' + signed.nonce)).wraps.length, 2, 'both per-board results survive a restart');
    const revoke = await call('/api/v1/devices/' + device.deviceId, { method: 'DELETE' });
    assert.equal(revoke.status, 200);
    assert.equal((await call(base + '/' + signed.nonce,
      { method: 'PUT', machine: true, body: first.wraps[0] })).error?.code, 'PERSON_ENROLL_REVOKED');
    const database = readFileSync(box.relayDirectory + '/devices.sqlite');
    for (const key of keys.values()) {
      assert.equal(database.includes(Buffer.from(decodeBoardKey(key))), false);
      assert.equal(database.includes(Buffer.from(key)), false, 'relay storage contains no usable board key');
    }
  });
