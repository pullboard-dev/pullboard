/** Client-only signing-root storage; PRF acquisition and recovery UI are separate [H15]. */
import { Refused } from "../../../kernel/light.js";
import {
  devicePublicKey,
  openAccountEnvelope,
  sealAccountEnvelope,
} from "./enrollment.js";

const encoder = new TextEncoder();
const modes = ['credential', 'recovery'];

/** Give a bounded refusal without exposing material or decrypted private bytes. */
function refusal() { return new Refused('PERSON_VAULT_AUTH', 'Use the original account, public root, revision and 32-byte credential or saved recovery key.'); }

/** Copy caller-owned material before any asynchronous work can observe mutations. */
function material(value) {
  if (!(value instanceof Uint8Array) || value.length !== 32) throw refusal();
  return new Uint8Array(value);
}

/** Encode the fixed-size scalar and public digest in browser-compatible base64url. */
function encode(value) { return btoa(String.fromCharCode(...value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, ''); }

/** Reject oversized, noncanonical or incorrectly sized encoded bytes before use. */
function decode(value, length) {
  if (typeof value !== 'string' || value.length !== Math.ceil(length * 4 / 3) || !/^[A-Za-z0-9_-]+$/u.test(value)) throw refusal();
  const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0));
  if (bytes.length !== length || encode(bytes) !== value) throw refusal();
  return bytes;
}

/** Bind a snapshot of the public root and account revision to a domain-separated key id. */
async function binding(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'account,publicRoot,revision' ||
      !/^[1-9][0-9]{0,19}$/u.test(value.account ?? '') || typeof value.account !== 'string' ||
      !Number.isSafeInteger(value.revision) || value.revision < 1) throw refusal();
  decode(value.publicRoot?.x, 32); decode(value.publicRoot?.y, 32);
  const publicRoot = devicePublicKey(value.publicRoot);
  const context = { account: value.account, revision: value.revision, publicRoot };
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(publicRoot)));
  return { ...context, keyId: 'root-v1-' + encode(new Uint8Array(digest)) };
}

/** Keep credential and recovery wraps cryptographically independent, including when inputs coincide. */
function envelopeContext(context, mode) {
  return { account: context.account, keyId: context.keyId + '-' + mode, revision: context.revision };
}

/** Normalize only bounded public fields and the requested wrapper; opening needs no other wrapper. */
async function record(value, selected) {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string' || serialized.length > 2048) throw refusal();
  const vault = JSON.parse(serialized);
  if (!vault || vault.v !== 1 || Object.keys(vault).some(k => !['v', 'account', 'revision', 'publicRoot', ...modes].includes(k))) throw refusal();
  const context = await binding({ account: vault.account, revision: vault.revision, publicRoot: vault.publicRoot });
  const result = { v: 1, account: context.account, revision: context.revision, publicRoot: context.publicRoot };
  for (const mode of selected ? [selected] : modes) {
    const wrap = vault[mode];
    const expected = envelopeContext(context, mode);
    if (!wrap || Object.keys(wrap).sort().join(',') !== 'account,ciphertext,keyId,nonce,revision,salt,v' || wrap.v !== 1 ||
        wrap.account !== expected.account || wrap.revision !== expected.revision || wrap.keyId !== expected.keyId) throw refusal();
    decode(wrap.salt, 32); decode(wrap.nonce, 12); decode(wrap.ciphertext, 48);
    result[mode] = { v: 1, ...expected, salt: wrap.salt, nonce: wrap.nonce, ciphertext: wrap.ciphertext };
  }
  return result;
}

/** Generate and seal a real root scalar without changing the existing 32-byte envelope contract. */
export async function createCredentialVault(prf, value) {
  let secret, scalar;
  try {
    secret = material(prf);
    if (!value || Object.keys(value).sort().join(',') !== 'account,revision') throw refusal();
    const input = { account: value.account, revision: value.revision };
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const exported = await crypto.subtle.exportKey('jwk', pair.privateKey);
    scalar = decode(exported.d, 32);
    const publicRoot = devicePublicKey({ kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y });
    delete exported.d;
    const context = await binding({ ...input, publicRoot });
    const recoveryKey = crypto.getRandomValues(new Uint8Array(32));
    const credential = await sealAccountEnvelope(secret, scalar, envelopeContext(context, 'credential'));
    const recovery = await sealAccountEnvelope(recoveryKey, scalar, envelopeContext(context, 'recovery'));
    return { vault: { v: 1, ...input, publicRoot, credential, recovery }, recoveryKey };
  } catch { throw refusal(); }
  finally { secret?.fill(0); scalar?.fill(0); }
}

/** Restore only the caller-pinned root as a non-extractable key, proving its actual signing identity. */
export async function openCredentialVault(input, value, expected, mode = 'credential') {
  let secret, scalar;
  try {
    secret = material(input);
    if (!modes.includes(mode)) throw refusal();
    const [context, vault] = await Promise.all([binding(expected), record(value, mode)]);
    if (vault.account !== context.account || vault.revision !== context.revision ||
        JSON.stringify(vault.publicRoot) !== JSON.stringify(context.publicRoot)) throw refusal();
    scalar = await openAccountEnvelope(secret, vault[mode], envelopeContext(context, mode));
    const algorithm = { name: 'ECDSA', namedCurve: 'P-256' };
    const privateKey = await crypto.subtle.importKey('jwk', { ...context.publicRoot, d: encode(scalar) }, algorithm, false, ['sign']);
    const publicKey = await crypto.subtle.importKey('jwk', context.publicRoot, algorithm, false, ['verify']);
    const probe = encoder.encode(JSON.stringify(['pullboard-vault-root-check', context.account, context.revision, context.publicRoot]));
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, probe);
    if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, probe)) throw refusal();
    return { privateKey, publicKey: context.publicRoot };
  } catch { throw refusal(); }
  finally { secret?.fill(0); scalar?.fill(0); }
}

/** Serialize only complete ciphertext envelopes and bounded public metadata for an untrusted relay. */
export async function serializeCredentialVault(value) {
  try { return JSON.stringify(await record(value)); }
  catch { throw refusal(); }
}
