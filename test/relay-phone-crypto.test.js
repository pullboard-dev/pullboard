/** Phone approvals bind opaque replies and proposals to their exact action [H16,B26,H17]. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createApprovalReply, openApproval, restoreLinkReply, sealApproval, signApprovalIntent, verifyApprovalIntent } from '../src/relay-approval.js';

/** Return a valid device-bound revoke context, with overrides for exact-binding controls. */
function revokeContext(overrides = {}) {
  const device = 'device-' + '1'.repeat(32);
  return { id: 'request-01', account: '7', publisher: 'a'.repeat(32), board: 'a'.repeat(32), device,
    action: 'revoke-device', target: device, machine: 'mac-alpha', command: 'pullboard relay revoke ' + device,
    expires: 1_900_000_000_000, ...overrides };
}

/** Change one valid context field so decryption must fail on authenticated binding, not parsing. */
function changedContext(context, changes) { return { ...context, ...changes }; }

test('phone approval envelopes hide grants, bind every action field, and authenticate native intent [H16,B26,H17]', async () => {
  const phone = await createApprovalReply();
  const native = await createApprovalReply();
  assert.equal(phone.privateKey.extractable, false);
  assert.equal(native.privateKey.extractable, false);
  assert.equal(Object.hasOwn(phone, 'storedKey'), false);
  assert.equal(Object.hasOwn(native, 'storedKey'), false);
  await assert.rejects(crypto.subtle.exportKey('jwk', native.privateKey));

  const context = revokeContext();
  const intentValue = { context, replyKey: native.publicKey };
  const intent = await sealApproval(intentValue, phone.publicKey, context, 'intent');
  const packet = { envelope: intent, mac: await signApprovalIntent(new Uint8Array(randomBytes(32)), intent) };
  const boardKey = new Uint8Array(randomBytes(32));
  packet.mac = await signApprovalIntent(boardKey, intent);
  assert.deepEqual(await verifyApprovalIntent(boardKey, packet), intent);
  assert.notEqual(intent.ciphertext, JSON.stringify(intentValue));

  const secretGrant = 'pg_' + 'G'.repeat(43);
  const replyValue = { grant: secretGrant, expires: context.expires };
  const reply = await sealApproval(replyValue, native.publicKey, context, 'reply');
  const serialized = JSON.stringify({ intent, reply, packet });
  assert.equal(serialized.includes(secretGrant), false, 'grant stays opaque in relay transport');
  assert.deepEqual(await openApproval(phone.privateKey, intent, context, 'intent'), intentValue);
  assert.deepEqual(await openApproval(native.privateKey, reply, context, 'reply'), replyValue);

  const mismatchCases = [
    changedContext(context, { id: 'request-02' }),
    changedContext(context, { account: '8' }),
    changedContext(context, { publisher: 'b'.repeat(32), board: 'b'.repeat(32) }),
    changedContext(context, { board: 'c'.repeat(32), publisher: 'c'.repeat(32) }),
    changedContext(context, { device: 'device-' + '2'.repeat(32), target: 'device-' + '2'.repeat(32) }),
    changedContext(context, { action: 'revoke-token', target: 'token-1' }),
    changedContext(context, { target: 'device-' + '3'.repeat(32) }),
    changedContext(context, { machine: 'mac-beta' }),
    changedContext(context, { command: 'pullboard relay revoke another-device' }),
    changedContext(context, { expires: context.expires + 1000 }),
  ];
  for (const other of mismatchCases) {
    await assert.rejects(openApproval(native.privateKey, reply, other, 'reply'), { code: 'PHONE_APPROVAL_AUTH' });
  }
  await assert.rejects(openApproval(native.privateKey, { ...reply, direction: 'intent' }, context, 'reply'), { code: 'PHONE_APPROVAL_AUTH' });
  await assert.rejects(openApproval(native.privateKey, { ...reply, ciphertext: (reply.ciphertext[0] === 'A' ? 'B' : 'A') + reply.ciphertext.slice(1) }, context, 'reply'), { code: 'PHONE_APPROVAL_AUTH' });
  await assert.rejects(openApproval(await createApprovalReply().then(value => value.privateKey), reply, context, 'reply'), { code: 'PHONE_APPROVAL_AUTH' });

  const tampered = { envelope: { ...intent, context: changedContext(context, { command: 'pullboard relay off' }) }, mac: packet.mac };
  await assert.rejects(verifyApprovalIntent(boardKey, tampered), { code: 'PHONE_APPROVAL_AUTH' });
  await assert.rejects(verifyApprovalIntent(new Uint8Array(randomBytes(32)), packet), { code: 'PHONE_APPROVAL_AUTH' });
});

test('only explicit new-board link replies can restore a durable reply key [H16,B26,H17]', async () => {
  const phone = await createApprovalReply();
  const link = await createApprovalReply({ link: true });
  assert.equal(link.privateKey.extractable, true);
  assert.ok(link.storedKey, 'only the non-person link request exports a durable reply key');
  const context = revokeContext({ action: 'link', target: 'fixture/new-repository', board: 'b'.repeat(32) });
  const response = { board: context.board, machineToken: 'pm_' + 'M'.repeat(43) };
  const envelope = await sealApproval(response, link.publicKey, context, 'reply');
  const restored = await restoreLinkReply(link.storedKey);
  assert.deepEqual(await openApproval(restored, envelope, context, 'reply'), response);
  assert.deepEqual(await openApproval(link.privateKey, envelope, context, 'reply'), response);

  const personReply = await createApprovalReply();
  assert.equal(personReply.privateKey.extractable, false);
  assert.equal(Object.hasOwn(personReply, 'storedKey'), false, 'native revoke replies have no persistable private key');
  await assert.rejects(openApproval(restored, envelope, revokeContext({ action: 'link', target: 'fixture/new-repository', board: 'c'.repeat(32) }), 'reply'), { code: 'PHONE_APPROVAL_AUTH' });
});
