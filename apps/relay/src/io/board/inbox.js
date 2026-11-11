/** Cross-board envelopes live beside existing opaque board records, under the same retention [E32,H16,H17]. */
import { DatabaseSync } from 'node:sqlite';
import { Refused } from '../../../../../packages/kernel/index.js';
import { boardLinkEnvelope } from '../../../../../packages/store/index.js';
import { boardLinkEnvelopeDigest } from '../../../../../packages/store/index.js';

/** Check optional additive storage without creating tables on an incoming-page read. */
function installed(db) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='board_link_delivery'").get());
}

/** Open a journal only inside the service's already-authorized lifecycle boundary. */
function withDatabase(file, write, work) {
  const db = new DatabaseSync(file, { readOnly: !write });
  try {
    db.exec('PRAGMA busy_timeout=30000');
    if (!write) return work(db);
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work(db);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* Preserve the original failure if SQLite already ended the transaction. */ }
      throw error;
    }
  } finally { db.close(); }
}

/** Commit a new correlation once; reject changed retries and backward source positions. */
export function appendBoardLinkEnvelope(file, value, { now, store }) {
  const envelope = boardLinkEnvelope(value);
  const encoded = JSON.stringify(envelope);
  const digest = boardLinkEnvelopeDigest(envelope);
  return withDatabase(file, true, db => {
    const existing = db.prepare('SELECT digest,receipt FROM board_link_delivery WHERE source_board=? AND correlation=?')
      .get(envelope.sourceBoardId, envelope.correlationId);
    if (existing) {
      if (existing.digest !== digest) throw new Refused('BOARD_LINK_CONFLICT', 'retry the exact sealed bytes or choose a new delivery correlation ID');
      return JSON.parse(existing.receipt);
    }
    const latest = db.prepare('SELECT position FROM board_link_delivery WHERE source_board=? AND link_id=? AND generation=? ORDER BY position DESC LIMIT 1')
      .get(envelope.sourceBoardId, envelope.linkId, envelope.generation);
    if (latest && latest.position >= envelope.position) throw new Refused('BOARD_LINK_REPLAY', 'send the next source position rather than replaying old state');
    const inserted = db.prepare('INSERT INTO board_link_delivery(source_board,correlation,link_id,generation,position,digest,envelope,receipt) VALUES (?,?,?,?,?,?,?,?)')
      .run(envelope.sourceBoardId, envelope.correlationId, envelope.linkId, envelope.generation, envelope.position, digest, encoded, '{}');
    const receipt = { version: 1, deliveryId: Number(inserted.lastInsertRowid), sourceBoardId: envelope.sourceBoardId,
      destinationBoardId: envelope.destinationBoardId, linkId: envelope.linkId, generation: envelope.generation,
      correlationId: envelope.correlationId, position: envelope.position, digest, at: new Date(now()).toISOString() };
    const saved = JSON.stringify(receipt);
    // The insertion remains uncommitted: quota's separate read sees the old total, and a refusal
    // rolls back the entire envelope. Its independent warning notice retains existing behavior.
    return store(Buffer.byteLength(encoded) + Buffer.byteLength(saved), () => {
      db.prepare('UPDATE board_link_delivery SET receipt=? WHERE delivery_id=?').run(saved, receipt.deliveryId);
      return receipt;
    });
  });
}

/** Read a bounded page without DDL or unrelated private board contents. */
export function readBoardLinkEnvelopes(file, after) {
  if (!Number.isSafeInteger(after) || after < 0) throw new Refused('BOARD_LINK_TRANSPORT', 'use the last nonnegative incoming delivery ID');
  return withDatabase(file, false, db => {
    if (!installed(db)) return [];
    return db.prepare('SELECT envelope,receipt FROM board_link_delivery WHERE delivery_id>? ORDER BY delivery_id LIMIT 100')
      .all(after).map(row => ({ envelope: JSON.parse(row.envelope), receipt: JSON.parse(row.receipt) }));
  });
}
