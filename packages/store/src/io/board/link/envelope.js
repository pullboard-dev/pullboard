/** A per-link capability reuses existing seals without holding another board's full key [E32,H17]. */
import { createHash } from 'node:crypto';
import { Refused } from "../../../../../kernel/index.js";
import { seal } from "../../../../../kernel/index.js";
import { unseal } from "../../../../../kernel/index.js";
import { boardReferenceId } from "../../../../../kernel/index.js";
import { boardLinkBody } from "../../../../../kernel/index.js";
import { boardLinkName } from "../../../../../kernel/index.js";
import { boardLinkFormat } from "../../../../../kernel/index.js";
import { discloseBoardState } from "../../../../../kernel/index.js";

const LIMIT = 65536;

/** Copy only bounded routing fields; opaque ciphertext never supplies its own identity. */
export function boardLinkEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['version', 'linkId', 'generation', 'sourceBoardId', 'destinationBoardId', 'position', 'correlationId', 'sealed'].includes(key))
      || value.version !== 1 || !Number.isSafeInteger(value.generation) || value.generation < 1
      || !Number.isSafeInteger(value.position) || value.position < 0) boardLinkFormat('Use an exact bounded delivery envelope');
  const sourceBoardId = boardReferenceId(value.sourceBoardId);
  const destinationBoardId = boardReferenceId(value.destinationBoardId);
  if (sourceBoardId === destinationBoardId || typeof value.sealed !== 'string' || value.sealed.length > 90000
      || !/^[A-Za-z0-9_-]+$/u.test(value.sealed)) boardLinkFormat('Use a sealed envelope between distinct boards');
  const bytes = Buffer.from(value.sealed, 'base64url');
  if (bytes.length < 29 || bytes.length > LIMIT || bytes.toString('base64url') !== value.sealed) boardLinkFormat('Use canonical bounded sealed bytes');
  return { version: 1, linkId: boardLinkName(value.linkId), generation: value.generation,
    sourceBoardId, destinationBoardId, position: value.position, correlationId: boardLinkName(value.correlationId), sealed: value.sealed };
}

/** Bind a retry to every routing field and the exact already-sealed bytes. */
export function boardLinkEnvelopeDigest(value) {
  return createHash('sha256').update(JSON.stringify(boardLinkEnvelope(value))).digest('hex');
}

/** Accept a server outcome only when it names these exact routing fields and ciphertext bytes. */
export function boardLinkDeliveryReceipt(value, input) {
  const envelope = boardLinkEnvelope(input);
  const fields = ['version', 'deliveryId', 'sourceBoardId', 'destinationBoardId', 'linkId', 'generation', 'correlationId', 'position', 'digest', 'at'];
  if (!value || Object.keys(value).some(key => !fields.includes(key)) || value.version !== 1
    || !Number.isSafeInteger(value.deliveryId) || value.deliveryId < 1 || typeof value.at !== 'string'
    || !Number.isFinite(Date.parse(value.at)) || new Date(value.at).toISOString() !== value.at
    || value.digest !== boardLinkEnvelopeDigest(envelope)) {
    throw new Refused('BOARD_LINK_TRANSPORT', 'read the exact durable receipt for this sealed delivery');
  }
  for (const key of ['sourceBoardId', 'destinationBoardId', 'linkId', 'generation', 'correlationId', 'position']) {
    if (value[key] !== envelope[key]) throw new Refused('BOARD_LINK_TRANSPORT', 'the receipt must match every delivery identity field');
  }
  return Object.fromEntries(fields.map(key => [key, value[key]]));
}

/** Validate decrypted state against the signed mode; unknown fields never become disclosed content. */
function announcement(value, body) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['version', 'linkId', 'generation', 'sourceBoardId', 'destinationBoardId', 'position', 'disclosure', 'rows'].includes(key))
      || value.version !== 1 || value.linkId !== body.linkId || value.generation !== body.generation
      || value.sourceBoardId !== body.child.boardId || value.destinationBoardId !== body.parent.boardId
      || value.disclosure !== body.disclosure || !Number.isSafeInteger(value.position) || value.position < 0) boardLinkFormat('The announcement does not match its signed link');
  let rows;
  if (body.disclosure === 'counts') {
    if (!value.rows || typeof value.rows !== 'object' || Array.isArray(value.rows)) boardLinkFormat('Use only native state counts');
    rows = {};
    let count = 0;
    for (const [state, amount] of Object.entries(value.rows)) {
      if (!['open', 'claimed', 'submitted', 'verified', 'withdrawn'].includes(state)
        || !Number.isSafeInteger(amount) || amount < 1 || amount > 10000) boardLinkFormat('Use bounded positive native state counts');
      rows[state] = amount; count += amount;
    }
    if (count > 10000) boardLinkFormat('The state-count payload exceeds its bound');
  } else {
    rows = discloseBoardState(body.disclosure, value.rows);
    if (JSON.stringify(rows) !== JSON.stringify(value.rows)
        || rows.some(row => row.board !== body.child.boardId)) boardLinkFormat('The state payload contains forbidden fields or another board’s items');
  }
  return { version: 1, linkId: body.linkId, generation: body.generation,
    sourceBoardId: body.child.boardId, destinationBoardId: body.parent.boardId,
    position: value.position, disclosure: body.disclosure, rows };
}

/**
 * Bind an independently provisioned per-link key to one signed generation. This capability has
 * neither a parent board key nor a key-distribution endpoint; missing capability refuses at use.
 */
export function createBoardLinkCapability(record, key) {
  const body = boardLinkBody(record);
  if (!(key instanceof Uint8Array) || key.length !== 32) throw new Refused('BOARD_LINK_AUTH', 'provide the independently provisioned 32-byte key for this link only');
  const raw = new Uint8Array(key);
  const binding = JSON.stringify(body);
  let closed = false;
  /** Keep the existing seal's authenticated domain unique to these exact endpoints and generation. */
  function context(position) {
    if (closed) throw new Refused('BOARD_LINK_AUTH', 'open a current per-link sealing capability before delivery');
    return { boardId: `board-link:${body.linkId}:${body.child.boardId}:${body.parent.boardId}:${body.generation}`,
      kind: 'request', sequence: position };
  }
  return Object.freeze({ binding,
    /** Seal only already-stripped state; retain these exact bytes for every transport retry. */
    async seal(correlationId, value) {
      const normalized = announcement(value, body);
      const correlation = boardLinkName(correlationId);
      const plain = Buffer.from(JSON.stringify({ version: 1, correlationId: correlation, announcement: normalized }));
      if (plain.length > LIMIT - 29) boardLinkFormat('The disclosed announcement exceeds the envelope bound');
      const bytes = await seal(raw, plain, context(normalized.position));
      return boardLinkEnvelope({ version: 1, linkId: body.linkId, generation: body.generation,
        sourceBoardId: body.child.boardId, destinationBoardId: body.parent.boardId,
        position: normalized.position, correlationId: correlation, sealed: Buffer.from(bytes).toString('base64url') });
    },
    /** Open only this link's envelopes and check every duplicated identity after authentication. */
    async open(value) {
      const envelope = boardLinkEnvelope(value);
      if (envelope.linkId !== body.linkId || envelope.generation !== body.generation
        || envelope.sourceBoardId !== body.child.boardId || envelope.destinationBoardId !== body.parent.boardId) boardLinkFormat('Use this capability only for its bound link generation');
      const plain = await unseal(raw, Buffer.from(envelope.sealed, 'base64url'), context(envelope.position));
      let decoded;
      try { decoded = JSON.parse(Buffer.from(plain).toString('utf8')); } catch { boardLinkFormat('The authenticated link payload is not JSON'); }
      if (!decoded || Object.keys(decoded).sort().join(',') !== 'announcement,correlationId,version'
        || decoded.version !== 1 || decoded.correlationId !== envelope.correlationId) boardLinkFormat('The delivery correlation does not match its authenticated payload');
      const normalized = announcement(decoded.announcement, body);
      if (normalized.position !== envelope.position) boardLinkFormat('The source position changed outside the authenticated payload');
      return normalized;
    },
    /** Drop this instance's key copy without changing any caller-owned key material. */
    close() { raw.fill(0); closed = true; },
  });
}
