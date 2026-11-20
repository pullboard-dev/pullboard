/** A canary alert on the board machine reaches a closed paired phone through the relay as a sealed wake-up, and the relay never holds the alert text [C7,H5]. */
import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import { createECDH } from 'node:crypto';
import { generateKeyPairSync } from 'node:crypto';
import { hkdfSync } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createRelayHandler } from '../../../relay/index.js';
import { observeRelayHealth } from '../../../../packages/link/index.js';
import { runRelayCanary } from '../../../../packages/link/index.js';
import { Refused } from '../../../../packages/kernel/index.js';
import { privateFixtureFiles } from '../../../../packages/gate/tests/fixtures/child.js';
import { cellRepo } from '../../../../packages/store/tests/fixtures/cell.js';

const TOKEN = `ps_${'A'.repeat(43)}`;
const DEVICE = `device-${'a'.repeat(32)}`;
const BOARD = 'b'.repeat(32);
const FAILED = { ok: false, step: 'pull', code: 'RELAY_READ', roundTripMs: 2, at: '2026-11-17T00:00:00.000Z' };
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

/** Decrypt a pushed body as the phone browser does (RFC 8291 aes128gcm) and return the wake-up bytes. */
function openPush(body, { ecdh, auth }) {
  const salt = body.subarray(0, 16);
  const senderPublic = body.subarray(21, 21 + body[20]);
  const record = body.subarray(21 + body[20]);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), senderPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdh.computeSecret(senderPublic), auth, keyInfo, 32));
  const decipher = createDecipheriv('aes-128-gcm', Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)), Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)));
  decipher.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  return plain.subarray(0, plain.length - 1);
}

test('cli.journeys-relay-push.an-alert-reaches-a-closed-paired-view-as: clause 1: an alert reaches a closed paired view as an OS notification with no plaintext at the relay [C7,H5,#9473]', async t => {
  const directory = privateFixtureFiles('pullboard-push-journey-').root;
  const pushed = [];
  const auth = {
    async authenticate(token) {
      if (token !== TOKEN) throw new Refused('AUTH_REQUIRED', 'sign in');
      return { id: token, kind: 'session', user: { id: 'acct', login: 'fixture' } };
    },
    linkedBoards() { return []; },
    forgetBoard() {},
    minimumEngineVersion() { return 1; },
    withBoard(board, work) { return work({ id: board, linkedAt: Date.now() }); },
    pendingCleanup() { return []; },
    finishCleanup() {},
    withCleanup(_board, work) { return work(); },
  };
  const push = { enabled: () => true, fetch: async (url, init) => { pushed.push({ url, init }); return { ok: true }; }, vapidKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), vapidPublic: 'public-key', subject: 'mailto:ops@example.com' };
  const service = createRelayHandler({ directory, auth, maintenanceMs: 0, push });
  const server = createServer((req, res) => { void service(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    service.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };

  // The paired phone is closed: only its stored push subscription is left at the relay.
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const phoneAuth = randomBytes(16);
  const subscription = { endpoint: 'https://push.example/phone', keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: phoneAuth.toString('base64url') } };
  assert.equal((await call('POST', `/api/v1/devices/${DEVICE}`, {})).status, 200);
  assert.equal((await call('POST', '/api/v1/push/subscribe', { device: DEVICE, subscription, kinds: ['alerts'] })).status, 200);

  // The board machine seals the canary alert and posts only its kind and sealed blob to the relay.
  const { root } = cellRepo(t, { real: true });
  observeRelayHealth(root, FAILED);
  assert.equal(observeRelayHealth(root, FAILED).transition, 'alert');
  const posts = [];
  const relayWake = {
    enabled: () => true,
    seal: text => Buffer.from(text).toString('base64url'),
    post: async wake => {
      posts.push(wake);
      const woke = await call('POST', `/api/v1/boards/${BOARD}/push/wake`, wake);
      assert.deepEqual([woke.status, woke.body.woke], [200, 1]);
    },
  };
  await assert.rejects(runRelayCanary({ enabled: true, root, agentId: 'canary-1', deadlineMs: 1000 }, {
    probe: async () => FAILED, now: () => Date.parse(FAILED.at), notify: async () => { throw new Error('relay unreachable'); }, relayWake,
  }), /relay unreachable/u);

  assert.equal(posts.length, 1);
  assert.deepEqual(Object.keys(posts[0]).sort(), ['kind', 'sealed']);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].url, 'https://push.example/phone');
  const wakeup = openPush(pushed[0].init.body, { ecdh, auth: phoneAuth });
  assert.deepEqual(wakeup, Buffer.concat([Buffer.from([1]), Buffer.from(posts[0].sealed, 'base64url')]), 'the phone is pushed the kind byte and the sealed blob, nothing else');
  // The phone opens the sealed blob; neither the post nor the push the relay sent holds the alert text.
  assert.match(Buffer.from(posts[0].sealed, 'base64url').toString(), /^Relay canary alert/u);
  assert.equal(JSON.stringify(posts).includes('RELAY_READ'), false);
  assert.equal(Buffer.from(pushed[0].init.body).toString('latin1').includes('RELAY_READ'), false);
});
