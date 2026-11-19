/** The signing boundary: one contract, a real Ed25519 form and a deterministic fake [C7]. */
import { createPrivateKey } from "node:crypto";
import { createPublicKey } from "node:crypto";
import { generateKeyPairSync } from "node:crypto";
import { sign } from "node:crypto";
import { verify } from "node:crypto";

/** Refuse an empty or non-string message the same way in both forms. */
function message(value) {
  if (typeof value !== "string" || value.length === 0) throw Object.assign(new Error("sign a non-empty message; pass the text to sign"), { code: "SIGN_EMPTY" });
  return Buffer.from(value, "utf8");
}

/** Refuse an encoding other than the default PEM form or base64url DER. */
function encodingOf(options) {
  const encoding = options?.encoding ?? "pem";
  if (encoding !== "pem" && encoding !== "der") throw Object.assign(new Error("encoding " + String(encoding) + " is not supported; pass pem or der"), { code: "SIGN_ENCODING" });
  return encoding;
}

/** The refusal for a key that is missing or is not a readable PEM private key, the same in both forms. */
function keyRefusal() { return Object.assign(new Error("sign with the caller's PEM private key; pass privateKey as PEM text"), { code: "SIGN_KEY" }); }

/** Refuse an algorithm other than ES256 or RS256, and a key that is not PEM private key text, the same way in both forms. */
function tokenOptions(options) {
  if (options?.algorithm !== "ES256" && options?.algorithm !== "RS256") throw Object.assign(new Error("algorithm " + String(options?.algorithm) + " is not supported; pass ES256 or RS256"), { code: "SIGN_ALGORITHM" });
  if (typeof options.privateKey !== "string" || !/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*-----END [A-Z ]*PRIVATE KEY-----/u.test(options.privateKey)) throw keyRefusal();
  return options;
}

/** The real form: node:crypto Ed25519. A key pair is { publicKey, privateKey }: PEM strings by default, base64url SPKI and PKCS#8 DER with { encoding: "der" }. */
export function createSigningAdapter(options) {
  const der = encodingOf(options) === "der";
  const format = der ? "der" : "pem";
  const out = (key, type) => (der ? key.export({ type, format }).toString("base64url") : key.export({ type, format }));
  const signatureOf = (buffer) => buffer.toString(der ? "base64url" : "base64");
  const bytesOf = (signature) => Buffer.from(signature, der ? "base64url" : "base64");
  const privateOf = (key) => (der ? createPrivateKey({ key: Buffer.from(key, "base64url"), format: "der", type: "pkcs8" }) : key);
  const publicOf = (key) => (der ? createPublicKey({ key: Buffer.from(key, "base64url"), format: "der", type: "spki" }) : createPublicKey(key));
  return Object.freeze({
    generateKeyPair() {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      return { publicKey: out(publicKey, "spki"), privateKey: out(privateKey, "pkcs8") };
    },
    sign(privateKey, text) { return signatureOf(sign(null, message(text), privateOf(privateKey))); },
    verify(publicKey, text, signature) { return verify(null, message(text), publicOf(publicKey), bytesOf(signature)); },
    /** Sign text for a token with the caller's PEM key: ES256 in ieee-p1363 form or RS256; the signature is base64url. */
    signWith(options, text) {
      const { algorithm, privateKey } = tokenOptions(options);
      const data = message(text);
      let key;
      try { key = createPrivateKey(privateKey); } catch { throw keyRefusal(); }
      const bytes = algorithm === "ES256" ? sign("sha256", data, { key, dsaEncoding: "ieee-p1363" }) : sign("RSA-SHA256", data, key);
      return bytes.toString("base64url");
    },
  });
}

/** The fake form: a deterministic table, no crypto; a signature is the public key and the message joined. With { encoding: "der" } keys and signatures are stable base64url strings. */
export function createFakeSigningAdapter(options) {
  const der = encodingOf(options) === "der";
  const wrap = (text) => (der ? Buffer.from(text).toString("base64url") : text);
  const unwrap = (text) => (der ? Buffer.from(text, "base64url").toString() : text);
  const encode = (text) => Buffer.from(text).toString(der ? "base64url" : "base64");
  const decode = (text) => Buffer.from(text, der ? "base64url" : "base64").toString();
  let count = 0;
  return Object.freeze({
    generateKeyPair() { count += 1; return { publicKey: wrap("fake-public-" + count), privateKey: wrap("fake-private-" + count) }; },
    sign(privateKey, text) { message(text); return encode(unwrap(privateKey).replace("private", "public") + "|" + text); },
    verify(publicKey, text, signature) { message(text); return decode(signature) === unwrap(publicKey) + "|" + text; },
    signWith(options, text) {
      const { algorithm } = tokenOptions(options);
      return Buffer.from("fake-" + algorithm + "|" + message(text).toString()).toString("base64url");
    },
  });
}
