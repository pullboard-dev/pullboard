/** The submitted-without-gate seam: a hand-written pass receipt in the shape a pulled gate records, for journeys that need an already submitted item [C7,#9872]. */
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as store from '../../../../packages/store/index.js';
import { onBoard } from './land/board.js';

/**
 * Write a pass receipt for a claimed item's committed head, record it on the board as a gate would, and return its id.
 * Why: a pulled gate's setup submit costs a whole runner settle, and a journey about a later move only needs the item
 * submitted; the receipt is the same immutable version-2 body the gate stores, bound to the item, its seat, its frozen
 * bar and the head the folder commits, so the board reads it as a pass exactly as it reads a real one [C7,#9872].
 *
 * @param {{ repo: string, git: (cwd: string, ...args: string[]) => string }} box - The e2e project box.
 * @param {number} id - A claimed item.
 * @param {string} [cwd] - The claimed item's folder; its HEAD is the committed head the receipt covers.
 * @returns {string} The receipt id.
 */
export function passReceipt(box, id, cwd = box.repo) {
  const head = String(box.git(cwd, 'rev-parse', 'HEAD')).trim();
  const tree = String(box.git(cwd, 'rev-parse', 'HEAD^{tree}')).trim();
  return onBoard(box, board => {
    const item = store.getItem(board, id);
    const { boardReceiptStore, receiptBody } = board.runtimePorts.sourceAdvanceReceipts;
    const body = { version: 2, id: randomUUID(), kind: 'submit', tree, head, main: null,
      command: createHash('sha256').update(`pass receipt ${id} ${head}`).digest('hex'), green: true, failures: [], load: null,
      at: new Date().toISOString(),
      proof: { item: id, frozenDigest: item.item_frozen_digest ?? null, seat: item.item_owner, runner: null, exitCode: 0,
        durationMs: 0, sourceClean: true, environment: null, counts: { passed: 1, failed: 0, skipped: 0 } } };
    const folder = boardReceiptStore(board);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileSync(join(folder, `${body.id}.json`), receiptBody(body), { mode: 0o600, flag: 'wx' });
    store.recordProofRun(board, { agentId: item.item_owner, itemId: id, receiptId: body.id });
    return body.id;
  });
}

/** How many runner gate jobs the board holds for an item; a seam that writes a receipt creates none. */
export function gateJobCount(box, id) {
  // @pullboard-board-file journey: a read-only count of the gate jobs the fixture board holds for one item
  const db = new DatabaseSync(join(box.repo, '.git', 'pullboard', 'board.sqlite'), { readOnly: true });
  try { return db.prepare("SELECT COUNT(*) AS n FROM job WHERE job_kind = 'gate' AND job_item = ?").get(id).n; } finally { db.close(); }
}
