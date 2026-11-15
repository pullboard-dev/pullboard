/** A stand-in relay and replica for the outbox's ordering code: an ordered log, a dropped reply, and one in-memory board per replica [C7,H16]. */
import {
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { relayOrdering } from '../../src/io/relay/ordering.js';

/** The board id and sealed-key environment every replica shares; the key never leaves the process. */
export const BOARD = '0123456789abcdef0123456789abcdef';

/**
 * The relay: it orders posted moves, one event per sequence, and refuses a claim of an item another claim already holds.
 * A dropped reply keeps the order but loses the answer, as a network cut after the relay took the move does.
 */
export function standInRelay() {
  const events = [];
  const relay = {
    events,
    posts: 0,
    reads: 0,
    /** Order one move as the relay would, and return the event it made. */
    post(move, sealed) {
      relay.posts += 1;
      const event = { event_id: events.length + 1, kind: 'move', sealed, sender: 'agent' };
      events.push(event);
      return event;
    },
    /** Decide a move's outcome from the claims a replica has already replayed in order: the first claim of an item wins. */
    decide(move, holders) {
      if (move.operation !== 'claim') return { ok: true, result: { operation: move.operation } };
      const item = move.args[0];
      if (holders.has(item)) return { error: { code: 'HELD', message: `#${item} is held by ${holders.get(item)}`, next: 'take another item: pullboard next' } };
      holders.set(item, move.args[1]);
      return { ok: true, result: { item } };
    },
    /** The ordered-prefix read every replica's catch-up makes. */
    async request(state, path) {
      relay.reads += 1;
      const after = Number(/after=(\d+)/u.exec(path)?.[1] ?? 0);
      return { events: events.slice(after) };
    },
  };
  return relay;
}

/** One replica: a real in-memory SQLite board_meta, the receipts it replays into, and the outbox ordering over them. */
export function replica(t, relay) {
  // The guard creates this folder when a replica first takes it; the checkout the ordering code reads its git facts from is this one, read only.
  const directory = join(tmpdir(), 'pullboard-outbox-replica-' + randomUUID());
  const checkout = import.meta.dirname;
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE board_meta (meta_key TEXT PRIMARY KEY, meta_value TEXT)');
  t.after(() => db.close());
  // The board is closed after every replayed record by the ordering code; the stand-in keeps its one database open.
  const board = { db: { prepare: (sql) => db.prepare(sql), exec: (sql) => db.exec(sql), close() {} }, clock: { now: () => new Date(0) } };
  const holders = new Map();
  const reported = [];
  const saved = [];
  const refusals = [];
  const state = { board: BOARD, url: 'http://relay.invalid', sequence: 0 };
  const ordering = relayOrdering({
    request: (link, path) => relay.request(link, path),
    localRecords: (root, work) => work(board),
    decoded: async () => { throw new Error('the stand-in relay serves no snapshot'); },
    replayRelayRecord: async (_board, _key, link, record) => {
      const move = JSON.parse(record.sealed);
      const outcome = relay.decide(move, holders);
      // An accepted move leaves its durable receipt; a refused one is recorded as a refusal only, as the engine does.
      if (!outcome.error) db.prepare('INSERT OR REPLACE INTO board_meta VALUES (?,?)').run('relay_receipt_' + move.id, JSON.stringify({ sequence: record.event_id, move: record.sealed, outcome }));
      else refusals.push({ sequence: record.event_id, id: move.id, error: outcome.error });
      db.prepare('INSERT OR REPLACE INTO board_meta VALUES (?,?)').run('relay_applied_sequence', String(record.event_id));
      return outcome;
    },
    reportRecoveredReply: (pending) => { reported.push(pending.move.id); },
    saveLink: (file, link) => { saved.push(link.sequence); },
    sealedRecord: async (key, move) => JSON.stringify(move),
    flush: async () => {},
    openBoard: () => board,
  });
  const senderPolicy = { relaySenderProblem: () => null, credentialActor: () => 'machine' };
  return {
    directory, state, db, reported, saved, refusals, senderPolicy,
    linkFile: join(directory, 'relay.json'),
    /** Catch this replica up to the relay's order. */
    catchUp: () => ordering.catchUp(checkout, join(directory, 'relay.json'), state, {}, senderPolicy),
    /** Whether this replica holds the move's durable engine receipt. */
    receipt: (id) => db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get('relay_receipt_' + id)?.meta_value ?? null,
  };
}

/** Make the sealed environment key the board's key for the duration of a test, then restore the environment. */
export function useBoardKey(t) {
  const saved = { key: process.env.PULLBOARD_RELAY_KEY, token: process.env.PULLBOARD_RELAY_TOKEN };
  process.env.PULLBOARD_RELAY_KEY = randomBytes(32).toString('base64url');
  process.env.PULLBOARD_RELAY_TOKEN = 'stand-in-token';
  t.after(() => {
    for (const [name, value] of [['PULLBOARD_RELAY_KEY', saved.key], ['PULLBOARD_RELAY_TOKEN', saved.token]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
}

/** A move as the engine prepares it: an id, an operation and its arguments. */
export const move = (id, operation, ...args) => ({ id, operation, args });
