/** The gate hop as one fenced store row: one owner, and a compare-and-set write so only one racing writer wins [C7,#8269]. */
import { Refused } from '../../../../kernel/light.js';
import { boardStanding } from './migrate.js';
import { recordSchemaStamp } from './migrate.js';
import { SCHEMA_DIGEST } from './schema/source.js';
import { SCHEMA_VERSION } from './schema/source.js';

/** One row per item: the hop's state, its one owner and owner epoch, and a version every write bumps. */
export const GATE_HOP_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS gate_hop (
  item INTEGER PRIMARY KEY,
  hop_commit TEXT NOT NULL,
  digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','driven','done','ended')),
  owner TEXT,
  epoch INTEGER NOT NULL,
  lease_until INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  result TEXT,
  version INTEGER NOT NULL
)`;

/**
 * Create the hop table when it is missing, and restamp a board that was current before it.
 * Why: a stamped board that gained the table without a restamp read as changed outside pullboard on every open [C7,#8465].
 */
export function ensureGateHopTable(db) {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'gate_hop'").get()) return;
  const current = boardStanding(db, SCHEMA_DIGEST, SCHEMA_VERSION) === 'current';
  db.exec(GATE_HOP_SCHEMA_SQL);
  if (current) recordSchemaStamp(db, SCHEMA_DIGEST);
}

/**
 * The item's hop row in the hop table's shape, with the version the write is fenced on, or null when none exists.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} item
 */
export function readGateHop(db, item) {
  const row = db.prepare('SELECT * FROM gate_hop WHERE item=?').get(item);
  if (!row) return null;
  return { state: row.state, owner: row.owner ?? null, epoch: row.epoch, leaseUntil: row.lease_until, attempts: row.attempts,
    commit: row.hop_commit, digest: row.digest, result: row.result === null ? null : JSON.parse(row.result), version: row.version };
}

/** The refusal a writer gets when another writer changed the row between its read and its write, naming the owner it lost to. */
function lostRace(db, item, actor) {
  const now = readGateHop(db, item);
  return new Refused('HOP_FENCED', `${actor ?? 'the writer'} lost the race for the hop on #${item}: owner ${now?.owner ?? 'none'} at epoch ${now?.epoch ?? 0} (state ${now?.state ?? 'missing'})`,
    'stop driving: another driver owns the hop; acquire it again if it lapses');
}

/**
 * Apply one hop move to the item's row: read it, let `decide` (the hop table, handed in by its caller) answer, then write only
 * if the row is unchanged since the read. Unless `enabled` is true (the caller passes gate.fencedHop, off by default) it reads and writes nothing and answers `{ off: true }`.
 * Why compare-and-set rather than a lock: two drivers on two connections may both read the queued hop; the version check makes
 * exactly one write land, and the other is refused HOP_FENCED naming the winner, so no gate is ever driven twice [C7].
 * Why `decide` and `enabled` are passed in: the hop table lives in the moves cell, above the store, and the store reads no settings; the caller wires both.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ item: number, actor?: string, decide: (hop: ReturnType<typeof readGateHop>) => ({ refused: { code: string, message: string, next?: string } } | { hop: object }),
 *   enabled: boolean, beforeWrite?: () => void }} options - `beforeWrite` is a test seam run between the read and the write.
 * @returns {{ off: true } | { hop: ReturnType<typeof readGateHop> }}
 */
export function gateHopMove(db, { item, actor, decide, enabled, beforeWrite }) {
  if (enabled !== true) return { off: true };
  if (!Number.isSafeInteger(item) || item < 1) throw new Refused('HOP_ITEM', 'a hop move names its item as a whole number', 'pass the item id');
  ensureGateHopTable(db);
  const read = readGateHop(db, item);
  const answer = decide(read);
  if (answer.refused) throw new Refused(answer.refused.code, answer.refused.message, answer.refused.next);
  const hop = answer.hop;
  beforeWrite?.();
  const values = [hop.commit, hop.digest, hop.state, hop.owner ?? null, hop.epoch, hop.leaseUntil, hop.attempts, hop.result == null ? null : JSON.stringify(hop.result)];
  const changed = read === null
    ? db.prepare(`INSERT INTO gate_hop (item, hop_commit, digest, state, owner, epoch, lease_until, attempts, result, version)
        VALUES (?,?,?,?,?,?,?,?,?,1) ON CONFLICT(item) DO NOTHING`).run(item, ...values).changes
    : db.prepare(`UPDATE gate_hop SET hop_commit=?, digest=?, state=?, owner=?, epoch=?, lease_until=?, attempts=?, result=?, version=version+1
        WHERE item=? AND version=?`).run(...values, item, read.version).changes;
  if (changed !== 1) throw lostRace(db, item, actor);
  return { hop: readGateHop(db, item) };
}
