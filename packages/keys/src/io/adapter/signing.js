/** The signing boundary: one contract, a real Ed25519 form and a deterministic fake [C7]. */
import { createPublicKey } from "node:crypto";
import { generateKeyPairSync } from "node:crypto";
import { sign } from "node:crypto";
import { verify } from "node:crypto";

/** Refuse an empty or non-string message the same way in both forms. */
function message(value) {
  if (typeof value !== "string" || value.length === 0) throw Object.assign(new Error("sign a non-empty message; pass the text to sign"), { code: "SIGN_EMPTY" });
  return Buffer.from(value, "utf8");
}

/** The real form: node:crypto Ed25519. A key pair is { publicKey, privateKey } as PEM strings. */
export function createSigningAdapter() {
  return Object.freeze({
    generateKeyPair() {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      return { publicKey: publicKey.export({ type: "spki", format: "pem" }), privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) };
    },
    sign(privateKey, text) { return sign(null, message(text), privateKey).toString("base64"); },
    verify(publicKey, text, signature) { return verify(null, message(text), createPublicKey(publicKey), Buffer.from(signature, "base64")); },
  });
}

/** The fake form: a deterministic table, no crypto; a signature is the public key and the message joined. */
export function createFakeSigningAdapter() {
  let count = 0;
  return Object.freeze({
    generateKeyPair() { count += 1; return { publicKey: "fake-public-" + count, privateKey: "fake-private-" + count }; },
    sign(privateKey, text) { message(text); return Buffer.from(privateKey.replace("private", "public") + "|" + text).toString("base64"); },
    verify(publicKey, text, signature) { message(text); return Buffer.from(signature, "base64").toString() === publicKey + "|" + text; },
  });
}
