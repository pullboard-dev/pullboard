/** HTTP boundary for the signed-in account vault: one opaque ciphertext per account, never keys [H5,H15,C7]. */
import { Refused } from '../../../../../packages/kernel/index.js';

const ROUTE = /^\/api\/v1\/vault$/u;

/** The request body cap: the vault limit as base64 plus room for its small fields; the store holds the exact byte limit. */
const BODY_BYTES = 1_400_000;

/** A field name that would carry a secret the relay must never hold: a prf output, a recovery secret or a private key. */
const SECRET_FIELD = /prf|recovery|private/iu;

/** Refuse a body naming a secret field at any depth, before anything is stored. */
function refuseSecretFields(value) {
  if (!value || typeof value !== 'object') return;
  for (const [name, inner] of Object.entries(value)) {
    if (SECRET_FIELD.test(name)) throw new Refused('VAULT_SECRET_FIELD', `the vault holds only ciphertext; remove the ${name} field and send nothing the relay could decrypt with`);
    refuseSecretFields(inner);
  }
}

/** Decode the ciphertext field, sent as base64url text. */
function ciphertextBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/u.test(value)) throw new Refused('VAULT_CIPHERTEXT', 'send the encrypted vault as base64url text');
  return Buffer.from(value, 'base64url');
}

/**
 * Route the account vault after the relay's person authentication: PUT stores the signed-in account's ciphertext at a
 * new revision and GET returns it. The account is the session's user, never a name in the request. The caller passes
 * the relay's own HTTP helpers as http, so this file imports no other cell.
 */
export function createVaultHandler({ authenticate, vaults, http }) {
  const { apiJson, apiRefusal, apiStatus, readApiBody, refusalDocument } = http;
  return async function handleVault(req, res) {
    let url;
    try { url = new URL(req.url ?? '/', 'http://127.0.0.1'); } catch { return false; }
    if (!ROUTE.test(url.pathname)) return false;
    try {
      if (req.method === 'PUT') {
        const who = await authenticate(req, true);
        const body = await readApiBody(req, { maxBytes: BODY_BYTES });
        refuseSecretFields(body);
        const { expected, revision, root, ciphertext } = body ?? {};
        apiJson(res, 200, vaults.write(who.user.id, { expected, revision, root, ciphertext: ciphertextBytes(ciphertext) }));
      } else if (req.method === 'GET') {
        const who = await authenticate(req, false);
        const row = vaults.read(who.user.id);
        if (!row) throw new Refused('NO_VAULT', 'this account has no vault yet; write one with PUT');
        apiJson(res, 200, { root: row.root, revision: row.revision, ciphertext: row.ciphertext.toString('base64url') });
      } else throw new Refused('NO_ENDPOINT', 'use PUT or GET on the vault');
    } catch (error) {
      apiJson(res, apiStatus(error), apiRefusal(error, refusalDocument));
    }
    return true;
  };
}
