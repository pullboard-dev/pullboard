/** One durable cross-board client reuses the authenticated relay and per-link sealing port [E32,H16,H17]. */
import { createHash } from 'node:crypto';
import { Refused } from "../../../../../kernel/index.js";
import { atomic } from "../event/log.js";
import { logEvent } from "../event/log.js";
import { boardId } from "../query.js";
import { authorizeBoardLink } from "../link.js";
import { boardStateAnnouncement } from "../link.js";
import { boardLinkBody } from "../../../../../kernel/index.js";
import { boardLinkName } from "../../../../../kernel/index.js";
import { boardReferenceId } from "../../../../../kernel/index.js";
import { boardLinkEnvelope } from "./envelope.js";
import { boardLinkEnvelopeDigest } from "./envelope.js";
import { boardLinkDeliveryReceipt } from "./envelope.js";

/** Read a caller-owned immutable identity cache without exposing mutable stored objects. */
function saved(board, key) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(key);
  return row ? JSON.parse(row.meta_value) : null;
}

/** Persist only bounded native JSON metadata inside the caller's transaction. */
function remember(board, key, value) {
  board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
    .run(key, JSON.stringify(value));
}

/** Keep the capability bound to this exact signed generation; a missing port never sends plaintext. */
function capabilityFor(capability, record, method) {
  if (capability?.binding !== JSON.stringify(boardLinkBody(record)) || typeof capability?.[method] !== 'function') {
    throw new Refused('BOARD_LINK_AUTH', 'provide the sealing capability for this exact link generation');
  }
  return capability[method].bind(capability);
}

/**
 * The folder transport of link/file.js, loaded at its first send or read: its module stays outside the closure every hot command
 * (status, next, claim) loads, whose module budgets only ratchet down. The folder and the bound board are checked here, at once.
 */
export function createBoardLinkFileTransport(folder, { board } = {}) {
  if (typeof folder !== 'string' || folder === '') throw new TypeError('board link file transport needs its delivery folder');
  const id = board === undefined ? null : boardReferenceId(board);
  let real = null;
  const loaded = () => (real ??= import('./file.js').then(module => module.createBoardLinkFileTransport(folder, { board })));
  return Object.freeze({ board: id,
    async send(value) { return (await loaded()).send(value); },
    async read(...args) { return (await loaded()).read(...args); },
  });
}

/** Bind a transport instance to one explicitly authenticated source or receiving board. */
export function createBoardLinkRelayTransport(state, { request }) {
  if (typeof request !== 'function') throw new TypeError('board link transport needs its authenticated request port');
  const id = boardReferenceId(state?.board);
  /** Reuse existing credential, engine, origin and deadline behavior without adopting another board's environment token. */
  const sendRequest = (path, options) => request(state, path, options, { ignoreRelayEnvironmentToken: true });
  return Object.freeze({ board: id,
    /** Publish already-signed consent; the server verifies both authorities and its global DAG. */
    async publish(record) {
      return sendRequest(`/api/v1/boards/${id}/links/${boardLinkName(record.linkId)}`, { method: 'PUT', body: { record } });
    },
    /** Post the exact retained sealed bytes; a lost acknowledgement can be retried unchanged. */
    async send(value) {
      const envelope = boardLinkEnvelope(value);
      if (envelope.sourceBoardId !== id) throw new Refused('BOARD_LINK_AUTH', 'use the transport authenticated for the envelope’s source board');
      const result = await sendRequest(`/api/v1/boards/${envelope.destinationBoardId}/link-deliveries`, { method: 'POST', body: envelope });
      return boardLinkDeliveryReceipt(result.receipt, envelope);
    },
    /** Read only this board's bounded incoming page through its own credential. */
    async read(after = 0) {
      if (!Number.isSafeInteger(after) || after < 0) throw new Refused('BOARD_LINK_TRANSPORT', 'use the last nonnegative incoming delivery ID');
      return sendRequest(`/api/v1/boards/${id}/link-deliveries?after=${after}`);
    },
  });
}

/**
 * Strip before sealing and retain one ciphertext per correlation before the first HTTP attempt.
 * Native metadata and queue/ack events commit together; retries cannot reseal into different bytes.
 */
export async function deliverBoardState(board, context, { authority, capability, transport }) {
  if (boardId(board) !== context?.sourceBoardId || transport?.board !== context.sourceBoardId) {
    throw new Refused('BOARD_LINK_AUTH', 'send from the actual source board using its own authenticated transport');
  }
  const record = await authorizeBoardLink(board, context, authority);
  const announcement = boardStateAnnouncement(board, context);
  const text = JSON.stringify(announcement);
  const contentDigest = createHash('sha256').update(text).digest('hex');
  const correlationId = boardLinkName(context.correlationId);
  const key = `board_link_outbox:${context.destinationBoardId}:${correlationId}`;
  let pending = saved(board, key);
  if (pending && pending.contentDigest !== contentDigest) throw new Refused('BOARD_LINK_CONFLICT', 'use a new correlation ID for changed disclosed content');
  if (!pending) {
    const envelope = boardLinkEnvelope(await capabilityFor(capability, record, 'seal')(correlationId, announcement));
    pending = atomic(board, () => {
      if (JSON.stringify(boardStateAnnouncement(board, context)) !== text) throw new Refused('BOARD_LINK_CONFLICT', 'refresh the link after its disclosure changed');
      const existing = saved(board, key);
      if (existing) {
        if (existing.contentDigest !== contentDigest) throw new Refused('BOARD_LINK_CONFLICT', 'use a new correlation ID after a competing send');
        return existing;
      }
      const value = { contentDigest, envelope, receipt: null };
      remember(board, key, value);
      logEvent(board, context.sourceBoardId, 'board_link_send', null, { linkId: record.linkId, correlationId, digest: boardLinkEnvelopeDigest(envelope) });
      return value;
    });
  }
  if (pending.receipt) return boardLinkDeliveryReceipt(pending.receipt, pending.envelope);
  const receipt = boardLinkDeliveryReceipt(await transport.send(pending.envelope), pending.envelope);
  return recordReceipt(board, key, contentDigest, { sourceBoardId: context.sourceBoardId, linkId: record.linkId, correlationId }, receipt);
}

/** Store a transport receipt on its queued delivery and log board_link_delivered in one write; an earlier receipt wins [E32,H16]. */
function recordReceipt(board, key, contentDigest, { sourceBoardId, linkId, correlationId }, receipt) {
  return atomic(board, () => {
    const current = saved(board, key);
    if (!current || current.contentDigest !== contentDigest) throw new Refused('BOARD_LINK_CONFLICT', 'restore the exact queued delivery before recording its acknowledgement');
    if (current.receipt) return boardLinkDeliveryReceipt(current.receipt, current.envelope);
    remember(board, key, { ...current, receipt });
    logEvent(board, sourceBoardId, 'board_link_delivered', null, { linkId, correlationId, receipt });
    return receipt;
  });
}

/**
 * Send again the stored sealed envelope of every queued delivery that holds no receipt, once each, in key order.
 * Why: deliverBoardState keeps the exact bytes until the transport acknowledges, but nothing re-sent them after a failed send [E32,H16].
 *
 * @param {object} board - The source board.
 * @param {{ transport: { send: (envelope: object) => Promise<object> } }} port - The transport bound to the source board.
 * @returns {Promise<{ sent: object[], failed: { key: string, correlationId: string, error: string }[] }>} Receipts stored now, and the entries that still hold none.
 */
export async function resendPendingBoardStates(board, { transport }) {
  const sent = [];
  const failed = [];
  const rows = board.db.prepare("SELECT meta_key, meta_value FROM board_meta WHERE meta_key GLOB 'board_link_outbox:*' ORDER BY meta_key").all();
  for (const { meta_key: key, meta_value: value } of rows) {
    const pending = JSON.parse(value);
    if (pending.receipt) continue;
    const envelope = boardLinkEnvelope(pending.envelope);
    try {
      const receipt = boardLinkDeliveryReceipt(await transport.send(envelope), envelope);
      sent.push(recordReceipt(board, key, pending.contentDigest, envelope, receipt));
    } catch (error) {
      failed.push({ key, correlationId: envelope.correlationId, error: String(error?.message ?? error) });
    }
  }
  return { sent, failed };
}

/** Apply a verified incoming state once, with its source-position cursor and durable retry outcome; the stored state carries the board-clock time it was received. */
export async function receiveBoardState(board, delivery, { authority, capability }) {
  const envelope = boardLinkEnvelope(delivery?.envelope);
  if (boardId(board) !== envelope.destinationBoardId) throw new Refused('BOARD_LINK_AUTH', 'open this delivery only on its exact receiving board');
  const receipt = boardLinkDeliveryReceipt(delivery.receipt, envelope);
  const record = await authorizeBoardLink(board, envelope, authority);
  const announcement = await capabilityFor(capability, record, 'open')(envelope);
  const key = `board_link_inbox:${envelope.sourceBoardId}:${envelope.correlationId}`;
  const stateKey = `board_link_state:${envelope.linkId}:${envelope.generation}:${envelope.sourceBoardId}`;
  return atomic(board, () => {
    // Decryption and signature verification await: inspect current consent again before effects.
    boardStateAnnouncement(board, { ...envelope, rows: [] });
    const previous = saved(board, key);
    if (previous) {
      if (previous.digest !== receipt.digest) throw new Refused('BOARD_LINK_CONFLICT', 'a received correlation ID cannot name changed ciphertext');
      return previous;
    }
    const latest = saved(board, stateKey);
    if (latest && latest.position >= announcement.position) throw new Refused('BOARD_LINK_REPLAY', 'read the latest source position before applying another announcement');
    remember(board, stateKey, { ...announcement, receivedAt: board.clock.now().toISOString() });
    remember(board, key, receipt);
    logEvent(board, envelope.sourceBoardId, 'board_link_state', null, { announcement, receipt });
    return receipt;
  });
}

export { readReceivedBoardState } from "../../../logic/board/link.js";
