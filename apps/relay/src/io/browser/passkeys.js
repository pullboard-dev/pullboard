/**
 * Passkeys in the relay page [E22,H16]: add one, confirm a person request with one, and show the person moves a
 * terminal started so they complete on one confirmation here. The grant and the assertion live only in memory.
 */
import { Refused } from './refused.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

/** Encode bytes as base64url, as the relay reads them. */
function encode(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/** Decode base64url text from the relay into bytes. */
function decode(text) {
  const plain = atob(text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - text.length % 4) % 4));
  return Uint8Array.from(plain, (char) => char.charCodeAt(0));
}

/** Refuse plainly where this browser has no passkeys at all. */
function requirePasskeys() {
  if (!globalThis.PublicKeyCredential || !navigator.credentials) {
    throw new Refused('PASSKEY_UNSUPPORTED', 'This browser has no passkeys. Use a phone or browser with Face ID, Touch ID or a security key.');
  }
}

/** Register a new passkey for the signed-in person; the authenticator asks for the person before it answers. */
export async function addPasskey(documentAt) {
  requirePasskeys();
  const start = await documentAt('/api/v1/passkeys/challenge', { method: 'POST', headers: JSON_HEADERS, body: '{}' });
  const credential = await navigator.credentials.create({ publicKey: {
    challenge: decode(start.challenge), rp: { id: start.rpId, name: 'Pullboard' },
    user: { id: decode(start.user.id), name: start.user.name, displayName: start.user.name },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' }, attestation: 'none', timeout: 120_000,
  } });
  return documentAt('/api/v1/passkeys', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ challenge: start.challenge, id: credential.id,
    clientDataJSON: encode(credential.response.clientDataJSON), authenticatorData: encode(credential.response.getAuthenticatorData()) }) });
}

/** The SHA-256 of a request's exact intent, which the board recomputes before it trusts the relay's stamp. */
export async function intentDigest(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Ask the relay for a single-use grant for this exact request, then have a passkey sign the grant's digest with the
 * person present. Returns what the request carries to the relay; nothing here is stored.
 */
export async function passkeyPresence(documentAt, board, value) {
  requirePasskeys();
  const issued = await documentAt('/api/v1/boards/' + board + '/person-grants', { method: 'POST', headers: JSON_HEADERS,
    body: JSON.stringify({ request: value.id, digest: await intentDigest(value) }) });
  const challenge = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(issued.grant)));
  const credential = await navigator.credentials.get({ publicKey: { challenge, userVerification: 'preferred', timeout: 120_000,
    allowCredentials: issued.credentials.map((id) => ({ type: 'public-key', id: decode(id) })) } });
  const response = credential.response;
  return { grant: issued.grant, credential: credential.id, clientDataJSON: encode(response.clientDataJSON),
    authenticatorData: encode(response.authenticatorData), signature: encode(response.signature) };
}

/** Say in words what a terminal-started person move does, so the person confirms what they read. */
export function proposalText(move) {
  const args = move.args ?? {};
  if (move.verb === 'answer') return `Answer decision #${move.item}: ${args.text}`;
  if (move.verb === 'spec-approve') return `Approve ${args.ids}${args.text ? ` as: ${args.text}` : ''}`;
  if (move.verb === 'spec-decline') return `Decline ${args.ids}: ${args.reason ?? ''}`;
  if (move.verb === 'land-waive') return `Waive ${args.waive} until ${args.until}: ${args.reason}`;
  if (move.verb === 'signing') return args.signed === 'off' ? 'Stop signing person moves with your passkey' : 'Sign person moves with your passkey';
  return `${move.verb} ${JSON.stringify(args)}`;
}

/**
 * Keep a small panel on the page while a paired board signs person moves: add a passkey when there is none, and a
 * card per terminal-started move with one button that confirms it on the passkey.
 *
 * @param {Document} doc
 * @param {{ documentAt: Function, boards: () => any[], confirm: (board: string, proposal: any) => Promise<any>, signal?: AbortSignal }} options
 */
export function installPersonPasskeys(doc, { documentAt, boards, confirm, signal }) {
  const done = new Set();
  let passkeys = null;
  let timer;
  /** Draw the panel from the boards' current sealed state. */
  async function render() {
    const signed = boards().filter((entry) => entry.state?.personSigning?.signed);
    let panel = doc.getElementById('person-passkeys');
    if (!signed.length) { panel?.remove(); return; }
    if (!panel) {
      panel = doc.createElement('section'); panel.id = 'person-passkeys'; panel.className = 'card-panel';
      panel.setAttribute('aria-label', 'Person moves waiting for your passkey');
      doc.querySelector('main')?.prepend(panel);
    }
    passkeys ??= (await documentAt('/api/v1/passkeys')).passkeys;
    const cards = [];
    if (!passkeys.length) {
      const add = doc.createElement('button'); add.type = 'button'; add.id = 'person-passkey-add'; add.textContent = 'Add a passkey';
      add.onclick = async () => {
        add.disabled = true;
        try { await addPasskey(documentAt); passkeys = null; add.remove(); await render(); }
        catch (error) { add.textContent = 'Passkey not added: ' + (error.message || 'try again'); add.disabled = false; }
      };
      const why = doc.createElement('p'); why.textContent = 'Person moves on this board are signed. Add a passkey to confirm them with Face ID, Touch ID or a key.';
      cards.push(why, add);
    }
    for (const entry of signed) {
      for (const proposal of entry.state.personProposals ?? []) {
        if (done.has(proposal.id) || Date.parse(proposal.expires) <= Date.now()) continue;
        const card = doc.createElement('div'); card.className = 'phone-approval'; card.dataset.proposal = proposal.id;
        const text = doc.createElement('p'); text.className = 'phone-approval-title'; text.textContent = proposalText(proposal.move) + (proposal.rows?.length ? '\n' + proposal.rows.map(row => `${row.id}: ${row.source ?? row.text}`).join('\n') : '') + (proposal.effect ? '\n' + JSON.stringify(proposal.effect, null, 2) : '');
        const button = doc.createElement('button'); button.type = 'button'; button.id = 'person-confirm-' + proposal.id; button.textContent = 'Confirm with passkey';
        button.onclick = async () => {
          button.disabled = true;
          try { await confirm(entry.id, proposal); done.add(proposal.id); card.remove(); }
          catch (error) { text.textContent = 'Not confirmed: ' + (error.message || 'try again'); button.disabled = false; }
        };
        card.append(text, button); cards.push(card);
      }
    }
    if (!panel.querySelector('button:disabled')) panel.replaceChildren(...cards);
  }
  /** Refresh once a second until the page loses relay access. */
  async function loop() {
    try { await render(); } catch { /* A failed refresh keeps the last panel; the next tick retries. */ }
    if (!signal?.aborted) timer = setTimeout(loop, 1000);
  }
  signal?.addEventListener('abort', () => { clearTimeout(timer); doc.getElementById('person-passkeys')?.remove(); }, { once: true });
  void loop();
}
