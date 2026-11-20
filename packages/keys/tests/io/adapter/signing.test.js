/** One contract suite runs both forms of the signing adapter [C7,#1428]. */
import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { createPublicKey } from "node:crypto";
import { generateKeyPairSync } from "node:crypto";
import { verify } from "node:crypto";
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

test('keys.io-adapter-signing.der-front-door-same-table: clause 2: the factories reached through loadSigningAdapter on the keys front door run the same table and stay synchronous, and the default PEM form passes its existing cases unchanged [C7,#1428]', async () => {
  const { createSigningAdapter: real, createFakeSigningAdapter: fake } = await door.loadSigningAdapter();
  assert.equal(typeof real, "function");
  assert.equal(typeof fake, "function");
  for (const make of [real, fake]) {
    for (const adapter of [make(), make({ encoding: "pem" }), make({ encoding: "der" })]) {
      const { publicKey, privateKey } = adapter.generateKeyPair();
      const signature = adapter.sign(privateKey, "ship it");
      assert.equal(adapter.verify(publicKey, "ship it", signature), true);
      assert.equal(adapter.verify(publicKey, "ship it!", signature), false);
    }
  }
  const { publicKey } = real().generateKeyPair();
  assert.match(publicKey, /^-----BEGIN PUBLIC KEY-----/u);
  assert.throws(() => real({ encoding: "jwk" }), { code: "SIGN_ENCODING" });
});

test('keys.io-adapter-signing.alg-signwith-es256-rs256: clause 1: createSigningAdapter().signWith({ algorithm: ES256 or RS256, privateKey: pem }, text) returns a base64url signature that node:crypto verify accepts (ES256 in ieee-p1363 form), and createFakeSigningAdapter() answers the same contract table with stable strings [C7,#1428]', () => {
  const real = createSigningAdapter();
  const fake = createFakeSigningAdapter();
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = (pair) => pair.privateKey.export({ type: "pkcs8", format: "pem" });
  const es = real.signWith({ algorithm: "ES256", privateKey: pem(ec) }, "ship it");
  const rs = real.signWith({ algorithm: "RS256", privateKey: pem(rsa) }, "ship it");
  assert.match(es, DER);
  assert.match(rs, DER);
  assert.equal(verify("sha256", Buffer.from("ship it"), { key: ec.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(es, "base64url")), true);
  assert.equal(verify("RSA-SHA256", Buffer.from("ship it"), rsa.publicKey, Buffer.from(rs, "base64url")), true);
  assert.equal(verify("sha256", Buffer.from("ship it!"), { key: ec.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(es, "base64url")), false);
  for (const algorithm of ["ES256", "RS256"]) {
    const first = fake.signWith({ algorithm, privateKey: pem(ec) }, "ship it");
    assert.match(first, DER);
    assert.equal(fake.signWith({ algorithm, privateKey: pem(ec) }, "ship it"), first, "the fake is stable");
  }
  for (const adapter of [real, fake]) {
    assert.throws(() => adapter.signWith({ algorithm: "HS256", privateKey: pem(ec) }, "ship it"), { code: "SIGN_ALGORITHM" });
    assert.throws(() => adapter.signWith({ algorithm: "ES256", privateKey: pem(ec) }, ""), { code: "SIGN_EMPTY" });
  }
});

test('keys.io-adapter-signing.signwith-refusals: clause 2: both forms refuse an unknown algorithm or an unreadable key with the same named refusal [C7,#1428]', () => {
  const real = createSigningAdapter();
  const fake = createFakeSigningAdapter();
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = ec.privateKey.export({ type: "pkcs8", format: "pem" });
  const label = "PRIVATE " + "KEY";
  const broken = "-----BEGIN " + label + "-----\nnot a key\n-----END " + label + "-----\n";
  for (const adapter of [real, fake]) {
    for (const privateKey of ["pem", "not a key", "", undefined, 7]) {
      assert.throws(() => adapter.signWith({ algorithm: "ES256", privateKey }, "ship it"), { code: "SIGN_KEY" }, "an unreadable key: " + String(privateKey));
    }
    assert.throws(() => adapter.signWith({ algorithm: "HS256", privateKey: pem }, "ship it"), { code: "SIGN_ALGORITHM" });
  }
  assert.throws(() => real.signWith({ algorithm: "ES256", privateKey: broken }, "ship it"), { code: "SIGN_KEY" }, "the real form names a PEM it cannot parse");
});
