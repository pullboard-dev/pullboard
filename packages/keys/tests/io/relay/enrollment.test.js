/** @pullboard-test-input packages/person/light.js packages/person/src/logic/vault.js */
/** Real root-key recovery; the PRF input is synthetic, not a WebAuthn ceremony [H15]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import {
  authenticatePersonEnrollment,
  createPersonRoot,
  sealAccountEnvelope,
} from "../../../../person/light.js";
import { createDeviceKeys } from "../../../index.js";

/** Open in an independent isolate that has never held the original private root. */
async function recoveredEnrollment(serialized, material, method, expected, body) {
  const isolated = JSON.parse(serialized);
  delete isolated[method === 'credential' ? 'recovery' : 'credential'];
  const source = `
    import { parentPort, workerData } from 'node:worker_threads';
    const { openCredentialVault } = await import(workerData.vaultModule);
    const { signPersonEnrollment } = await import(workerData.enrollmentModule);
    const root = await openCredentialVault(workerData.material, JSON.parse(workerData.serialized), workerData.expected, workerData.method);
    let exportRefused = false;
    try { await crypto.subtle.exportKey('jwk', root.privateKey); }
    catch { exportRefused = true; }
    const signed = await signPersonEnrollment(root.privateKey, workerData.body);
    parentPort.postMessage({ signed, extractable: root.privateKey.extractable, exportRefused, node: process.version });
    parentPort.close();
  `;
  const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(source)), { workerData: {
    serialized: JSON.stringify(isolated), material, method, expected, body,
    vaultModule: new URL('../../../../person/light.js', import.meta.url).href,
    enrollmentModule: new URL('../../../../person/light.js', import.meta.url).href,
  } });
  try {
    return await new Promise((resolve, reject) => {
      let result;
      worker.on('message', value => { result = value; });
      worker.once('error', reject);
      worker.once('exit', code => code === 0 && result ? resolve(result) : reject(new Error('recovery worker closed without success: ' + code)));
    });
  } finally { await worker.terminate(); }
}

/** Alter authenticated bytes without making an accidentally identical replacement. */
function changed(value) {
  const bytes = Buffer.from(value, 'base64url');
  bytes[0] ^= 1;
  return bytes.toString('base64url');
}

test('an account root survives storage loss through credential and recovery envelopes [H15]', { timeout: 60_000 }, async () => {
  // budget: a hang ceiling for real crypto and owned worker shutdown, not a speed assertion.
  console.log('vault runtime ' + JSON.stringify({ node: process.version, executable: process.execPath,
    sha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex') }));
  assert.equal(existsSync(new URL('../../../../person/src/logic/vault.js', import.meta.url)), true,
    'a credential vault must seal and restore the actual signing root');
  const { createCredentialVault, openCredentialVault, serializeCredentialVault } = await import("../../../../person/light.js");
  const prf = crypto.getRandomValues(new Uint8Array(32));
  const context = { account: '42', revision: 1 };
  let created = await createCredentialVault(prf, context);
  const publicRoot = structuredClone(created.vault.publicRoot);
  const recoveryKey = new Uint8Array(created.recoveryKey);
  const serialized = await serializeCredentialVault(created.vault);
  created = null; // The fresh isolates below receive no original CryptoKey or hidden browser state.
  const vault = JSON.parse(serialized);
  const expected = { ...context, publicRoot };
  assert.ok(serialized.length <= 2048, 'relay vault metadata and ciphertext are bounded');
  assert.deepEqual(Object.keys(vault).sort(), ['account', 'credential', 'publicRoot', 'recovery', 'revision', 'v']);
  for (const secret of [prf, recoveryKey]) assert.equal(serialized.includes(Buffer.from(secret).toString('base64url')), false);
  for (const name of ['privateKey', 'recoveryKey', '"d":']) assert.equal(serialized.includes(name), false);
  for (const method of ['credential', 'recovery']) {
    const device = await createDeviceKeys();
    const body = { v: 1, account: '42', device: device.deviceId, publicKey: device.publicKey,
      origin: 'https://pullboard.example', nonce: Buffer.alloc(32, method === 'credential' ? 1 : 2).toString('base64url'),
      expires: 1_800_000_060_000, grants: ['a'.repeat(32)] };
    const restored = await recoveredEnrollment(serialized, method === 'credential' ? prf : recoveryKey, method, expected, body);
    assert.equal(restored.extractable, false);
    assert.equal(restored.exportRefused, true, 'actual private-key export is refused after storage loss');
    assert.equal(restored.node, process.version);
    assert.deepEqual(await authenticatePersonEnrollment(publicRoot, restored.signed,
      { account: '42', origin: body.origin, nonce: body.nonce, grants: body.grants, now: 1_800_000_000_000 }), body);
    const secret = method === 'credential' ? prf : recoveryKey;
    await assert.rejects(openCredentialVault(new Uint8Array(32), vault, expected, method), { code: 'PERSON_VAULT_AUTH' });
    await assert.rejects(openCredentialVault(secret, { ...vault, [method]: { ...vault[method], ciphertext: changed(vault[method].ciphertext) } },
      expected, method), { code: 'PERSON_VAULT_AUTH' });
  }
  const stranger = await createPersonRoot();
  for (const wrong of [{ ...expected, account: '43' }, { ...expected, revision: 2 }, { ...expected, publicRoot: stranger.publicKey }]) {
    await assert.rejects(openCredentialVault(prf, vault, wrong), { code: 'PERSON_VAULT_AUTH' });
  }
  for (const wrong of [{ ...vault, v: 2 }, { ...vault, publicRoot: stranger.publicKey },
    { ...vault, credential: vault.recovery, recovery: vault.credential }]) {
    await assert.rejects(openCredentialVault(prf, wrong, expected), { code: 'PERSON_VAULT_AUTH' });
  }
  for (const secret of [new Uint8Array(31), new Uint8Array(33)]) {
    await assert.rejects(createCredentialVault(secret, context), { code: 'PERSON_VAULT_AUTH' });
  }
  await assert.rejects(serializeCredentialVault({ ...vault, privateKey: 'must never serialize' }), { code: 'PERSON_VAULT_AUTH' });
  await assert.rejects(serializeCredentialVault({ ...vault, recovery: { ...vault.recovery, extra: 'secret' } }), { code: 'PERSON_VAULT_AUTH' });
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const wrongPrivate = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const mismatched = await sealAccountEnvelope(prf, Buffer.from(wrongPrivate.d, 'base64url'),
    { account: vault.account, keyId: vault.credential.keyId, revision: vault.revision });
  await assert.rejects(openCredentialVault(prf, { ...vault, credential: mismatched }, expected),
    { code: 'PERSON_VAULT_AUTH' }, 'a decryptable scalar must actually sign for the pinned public root');
});
