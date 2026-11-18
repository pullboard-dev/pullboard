/** A folder carries sealed board-link envelopes between two boards on one machine [E32,H16,H17]. */
import { mkdirSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Refused } from "../../../../../kernel/index.js";
import { boardReferenceId } from "../../../../../kernel/index.js";
import { writeFileAtomic } from '../../atomic.js';
import { boardLinkEnvelope } from "./envelope.js";
import { boardLinkEnvelopeDigest } from "./envelope.js";
import { boardLinkDeliveryReceipt } from "./envelope.js";

/** Read one board's delivery files in delivery order; a name is the zero-padded delivery ID. */
function deliveries(directory) {
  let names;
  try { names = readdirSync(directory).filter(name => /^\d{12}\.envelope$/u.test(name)).sort(); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return names.map(name => JSON.parse(readFileSync(join(directory, name), 'utf8')));
}

/** Replace the relay's HTTP request port with a folder; each destination board reads only its own subfolder. */
export function createBoardLinkFileTransport(folder, { board } = {}) {
  if (typeof folder !== 'string' || folder === '') throw new TypeError('board link file transport needs its delivery folder');
  const id = board === undefined ? null : boardReferenceId(board);
  return Object.freeze({ board: id,
    /** Append the exact sealed bytes once; a retry of the same envelope returns its first receipt unchanged. */
    async send(value) {
      const envelope = boardLinkEnvelope(value);
      if (id !== null && envelope.sourceBoardId !== id) throw new Refused('BOARD_LINK_AUTH', 'use the transport for the envelope’s source board');
      const directory = join(folder, envelope.destinationBoardId);
      mkdirSync(directory, { recursive: true });
      const existing = deliveries(directory);
      const digest = boardLinkEnvelopeDigest(envelope);
      const same = existing.find(row => row.envelope.sourceBoardId === envelope.sourceBoardId && row.envelope.correlationId === envelope.correlationId);
      if (same) {
        if (same.receipt.digest !== digest) throw new Refused('BOARD_LINK_CONFLICT', 'a correlation ID cannot name changed ciphertext');
        return boardLinkDeliveryReceipt(same.receipt, envelope);
      }
      const deliveryId = existing.length + 1;
      const receipt = boardLinkDeliveryReceipt({ version: 1, deliveryId, sourceBoardId: envelope.sourceBoardId,
        destinationBoardId: envelope.destinationBoardId, linkId: envelope.linkId, generation: envelope.generation,
        correlationId: envelope.correlationId, position: envelope.position, digest, at: new Date().toISOString() }, envelope);
      const name = String(deliveryId).padStart(12, '0');
      writeFileAtomic(join(directory, `${name}.envelope`), JSON.stringify({ envelope, receipt }));
      return receipt;
    },
    /** Read the destination board's deliveries after a delivery ID, as the relay page does. */
    async read(after = 0, destination = id) {
      if (!Number.isSafeInteger(after) || after < 0) throw new Refused('BOARD_LINK_TRANSPORT', 'use the last nonnegative incoming delivery ID');
      if (destination === null) throw new Refused('BOARD_LINK_TRANSPORT', 'name the receiving board this transport reads for');
      const rows = deliveries(join(folder, boardReferenceId(destination))).filter(row => row.receipt.deliveryId > after);
      return { deliveries: rows.map(row => ({ envelope: row.envelope, receipt: row.receipt })) };
    },
  });
}
