/** One contract suite runs both forms of the signing adapter [C7,#1428]. */
import assert from "node:assert/strict";
import { test } from "node:test";
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
