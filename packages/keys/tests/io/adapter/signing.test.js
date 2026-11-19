/** One contract suite runs both forms of the signing adapter [C7,#1428]. */
import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { createPublicKey } from "node:crypto";
import { test } from "node:test";
import * as door from "../../../index.js";
import { createFakeSigningAdapter } from "../../../src/io/adapter/signing.js";
import { createSigningAdapter } from "../../../src/io/adapter/signing.js";

const FORMS = { real: createSigningAdapter, fake: createFakeSigningAdapter };

test('keys.adapter-signing.both-forms-sign-and-verify: clause 1: createSigningAdapter and createFakeSigningAdapter both sign a message and verify it true with the same public key, and false for a changed message [C7,#1428]', () => {
  for (const [form, make] of Object.entries(FORMS)) {
    const adapter = make();
    const { publicKey, privateKey } = adapter.generateKeyPair();
    const signature = adapter.sign(privateKey, "ship it");
    assert.equal(adapter.verify(publicKey, "ship it", signature), true, form + " verifies the signed message");
    assert.equal(adapter.verify(publicKey, "ship it!", signature), false, form + " refuses a changed message");
  }
});

test('keys.adapter-signing.both-forms-refuse-an-empty-message: clause 2: both signing forms refuse an empty message with the same named refusal [C7,#1428]', () => {
  for (const [form, make] of Object.entries(FORMS)) {
    const adapter = make();
    const { privateKey } = adapter.generateKeyPair();
    assert.throws(() => adapter.sign(privateKey, ""), { code: "SIGN_EMPTY" }, form + " refuses an empty message");
  }
});

const DER = /^[A-Za-z0-9_-]+$/u;

test('keys.io-adapter-signing.der-contract-table: clause 1: createSigningAdapter and createFakeSigningAdapter with encoding der return base64url SPKI and PKCS#8 keys and signatures, verify true for the signed text and false for a changed one [C7,#1428]', () => {
  for (const [form, make] of Object.entries(FORMS)) {
    const adapter = make({ encoding: "der" });
    const { publicKey, privateKey } = adapter.generateKeyPair();
    assert.match(publicKey, DER, form + " public key is base64url");
    assert.match(privateKey, DER, form + " private key is base64url");
    if (form === "real") {
      assert.equal(createPublicKey({ key: Buffer.from(publicKey, "base64url"), format: "der", type: "spki" }).asymmetricKeyType, "ed25519");
      assert.equal(createPrivateKey({ key: Buffer.from(privateKey, "base64url"), format: "der", type: "pkcs8" }).asymmetricKeyType, "ed25519");
    }
    const signature = adapter.sign(privateKey, "ship it");
    assert.match(signature, DER, form + " signature is base64url");
    assert.equal(adapter.verify(publicKey, "ship it", signature), true, form + " verifies the signed text");
    assert.equal(adapter.verify(publicKey, "ship it!", signature), false, form + " refuses a changed text");
    assert.throws(() => adapter.sign(privateKey, ""), { code: "SIGN_EMPTY" }, form + " refuses an empty message");
  }
});

test('keys.io-adapter-signing.der-front-door-same-table: clause 2: both factories imported from the keys front door run the same table, and the default PEM form passes its existing cases unchanged [C7,#1428]', () => {
  assert.equal(typeof door.createSigningAdapter, "function");
  assert.equal(typeof door.createFakeSigningAdapter, "function");
  for (const make of [door.createSigningAdapter, door.createFakeSigningAdapter]) {
    for (const adapter of [make(), make({ encoding: "pem" })]) {
      const { publicKey, privateKey } = adapter.generateKeyPair();
      const signature = adapter.sign(privateKey, "ship it");
      assert.equal(adapter.verify(publicKey, "ship it", signature), true);
      assert.equal(adapter.verify(publicKey, "ship it!", signature), false);
    }
  }
  const { publicKey } = door.createSigningAdapter().generateKeyPair();
  assert.match(publicKey, /^-----BEGIN PUBLIC KEY-----/u);
  assert.throws(() => door.createSigningAdapter({ encoding: "jwk" }), { code: "SIGN_ENCODING" });
});
