/** Durable opaque snapshot objects, staged uploads and renewable reader pins; keys stay on devices [H15,H17,H18]. */
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Refused } from '../../../../../packages/kernel/index.js';
import {
  PAGE_CIPHER_BYTES,
  PAGE_FANOUT,
  pageReference,
} from '../../../../../packages/pages/index.js';

const UPLOAD_MS = 3_600_000;
const READ_MS = 900_000;
const MAX_DEPTH = 64;

/** Validate content identities without ever treating request text as a filename. */
function objectId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw new Refused('BAD_PAGE', 'Use the encrypted page content id returned by this device.');
  return value;
}

/** Bind sessions to server-derived user and device attribution, never an uploaded account field. */
function principalKey(principal) {
  if (!principal || !['person', 'machine', 'agent'].includes(principal.kind) || typeof principal.userId !== 'string' || !principal.userId ||
      principal.kind === 'machine' && typeof principal.machine !== 'string' || principal.kind === 'agent' && typeof principal.agent !== 'string') throw new Refused('BAD_SENDER', 'Use the server-authenticated user and device for sealed page access.');
  return JSON.stringify([principal.userId, principal.kind, principal.machine ?? principal.agent ?? null]);
}

/** Manage one board's objects; callers authorize and hold the shared auth lifecycle lock around every operation. */
export function createRelayPages({ directory, boardId, now = Date.now, database, transaction }) {
  if (typeof directory !== 'string' || !/^[0-9a-f]{32}$/u.test(boardId ?? '') || typeof now !== 'function') throw new Refused('RELAY_CONFIG', 'Configure private page storage for a persistent board id.');
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const parent = lstatSync(root);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.mode & 0o077) throw new Refused('RELAY_STORAGE', 'Keep relay page storage in a private directory.');
  const file = join(root, boardId + '.journal.sqlite');
  try { closeSync(openSync(file, 'wx', 0o600)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const entry = lstatSync(file);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.mode & 0o077) throw new Refused('RELAY_STORAGE', 'Keep relay page databases as private regular files.');
  const ownsDatabase = database === undefined;
  const db = database ?? new DatabaseSync(file);
  let closed = false;
  /** Initialize only opaque page tables; a borrowed journal connection owns the enclosing transaction. */
  function initialize() {
    db.exec(`CREATE TABLE IF NOT EXISTS page_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS page_object (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL,
        payload BLOB NOT NULL, children TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS page_upload (id TEXT PRIMARY KEY, principal TEXT NOT NULL,
        sequence INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS page_upload_object (upload TEXT NOT NULL REFERENCES page_upload(id) ON DELETE CASCADE,
        object TEXT NOT NULL REFERENCES page_object(id), PRIMARY KEY(upload,object));
      CREATE TABLE IF NOT EXISTS page_pin (id TEXT PRIMARY KEY, principal TEXT NOT NULL, root TEXT NOT NULL,
        reference TEXT NOT NULL, expires INTEGER NOT NULL, UNIQUE(principal,root));`);
    const saved = db.prepare('SELECT key,value FROM page_meta ORDER BY key').all();
    if (!saved.length) db.prepare('INSERT INTO page_meta(key,value) VALUES (?,?),(?,?)').run('board', boardId, 'format', '1');
    else if (saved.length !== 2 || saved[0].key !== 'board' || saved[0].value !== boardId || saved[1].key !== 'format' || saved[1].value !== '1') {
      throw new Refused('RELAY_STORAGE', 'Restore this page database with its original board identity and supported format.');
    }
  }
  try {
    if (ownsDatabase) {
      db.exec('PRAGMA busy_timeout=30000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; BEGIN IMMEDIATE');
      initialize(); db.exec('COMMIT');
    } else {
      if (typeof transaction !== 'function') throw new Refused('RELAY_CONFIG', 'Borrow a journal connection with its shared transaction boundary.');
      transaction(initialize);
    }
  } catch (error) {
    if (ownsDatabase) {
      try { db.exec('ROLLBACK'); } catch { /* Initialization may have failed before its transaction. */ }
      db.close();
    }
    throw error;
  }

  /** Refuse invalid clocks and use after shutdown without leaking native database messages. */
  function clock() {
    if (closed) throw new Refused('RELAY_CLOSED', 'Open the relay page store before using it.');
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Refused('RELAY_CLOCK', 'Configure a valid relay page-storage clock.');
    return value;
  }

  /** Keep staging and collection changes transactional; publication itself is owned by the journal. */
  function atomic(work) {
    clock();
    if (transaction) return transaction(work);
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      if (result && typeof result.then === 'function') throw new Refused('RELAY_CONFIG', 'Finish synchronous page storage before awaiting.');
      db.exec('COMMIT'); return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  /** Resolve only the caller's live upload; a guessed upload id is not authority. */
  function upload(id, principal) {
    const saved = db.prepare('SELECT * FROM page_upload WHERE id=?').get(String(id));
    if (!saved || saved.principal !== principalKey(principal) || saved.expires <= clock()) throw new Refused('SNAPSHOT_UPLOAD_EXPIRED', 'Start a new sealed upload or resume this machine’s unexpired upload.');
    return saved;
  }

  /** Validate only opaque graph metadata, not encrypted page contents. */
  function childrenOf(row) {
    let children;
    try { children = JSON.parse(row.children); } catch { throw new Refused('RELAY_STORAGE', 'Restore valid opaque page references.'); }
    if (!Array.isArray(children) || children.length > PAGE_FANOUT) throw new Refused('RELAY_STORAGE', 'Restore valid bounded page references.');
    return children.map(objectId);
  }

  /** Find reachable objects, accepting shared subtrees but refusing cycles in a published graph. */
  function graph(roots, complete) {
    const found = new Set();
    const visiting = new Set();
    const object = db.prepare('SELECT id,children FROM page_object WHERE id=?');
    /** Walk a bounded depth without interpreting the stored cipher bytes. */
    function visit(id, depth) {
      objectId(id);
      if (found.has(id)) return;
      if (depth > MAX_DEPTH || visiting.has(id)) {
        if (complete) throw new Refused('SNAPSHOT_GRAPH', 'Upload a complete, acyclic sealed page index.');
        return;
      }
      const row = object.get(id);
      if (!row) {
        if (complete) {
          const error = new Refused('SNAPSHOT_PAGE_MISSING', 'Upload the referenced sealed page before publishing this snapshot.');
          error.page = id;
          throw error;
        }
        return;
      }
      visiting.add(id);
      for (const child of childrenOf(row)) visit(child, depth + 1);
      visiting.delete(id); found.add(id);
    }
    for (const id of roots) visit(id, 0);
    return found;
  }

  /** Start one principal-bound upload; unfinished sessions expire instead of holding data forever. */
  function begin(principal, sequence) {
    if (!['person', 'machine'].includes(principal?.kind)) throw new Refused('HUMAN_REQUIRED', 'Upload snapshots from a signed-in person or their linked machine.');
    const owner = principalKey(principal);
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Refused('BAD_SEQUENCE', 'Name the nonnegative snapshot coverage sequence.');
    return atomic(() => {
      if (db.prepare('SELECT COUNT(*) AS count FROM page_upload WHERE expires>?').get(clock()).count >= 64) throw new Refused('RELAY_BUSY', 'Resume an existing upload before starting another one.');
      const id = randomUUID();
      db.prepare('INSERT INTO page_upload VALUES (?,?,?,?)').run(id, owner, sequence, clock() + UPLOAD_MS);
      return { id, sequence };
    });
  }

  /** Resume the same authenticated machine's interrupted upload without inventing another sequence. */
  function resume(id, principal, sequence) {
    return atomic(() => {
      const saved = upload(id, principal);
      if (saved.sequence !== sequence) throw new Refused('BAD_SEQUENCE', 'Resume the original upload coverage sequence.');
      db.prepare('UPDATE page_upload SET expires=? WHERE id=?').run(clock() + UPLOAD_MS, saved.id);
      return { id: saved.id, sequence: saved.sequence };
    });
  }

  /** Store an idempotent bounded object, checking the account budget before adding new bytes. */
  function put(id, principal, object, checkBudget = () => {}) {
    const identity = objectId(object?.id);
    if (!(object.bytes instanceof Uint8Array) || !object.bytes.byteLength || object.bytes.byteLength > PAGE_CIPHER_BYTES ||
        !Number.isSafeInteger(object.sequence) || object.sequence < 0 || !Array.isArray(object.children) || object.children.length > PAGE_FANOUT ||
        createHash('sha256').update(object.bytes).digest('hex') !== identity) throw new Refused('BAD_PAGE', 'Upload the complete bounded cipher bytes under their own content id.');
    const children = JSON.stringify(object.children.map(objectId));
    if (object.children.includes(identity)) throw new Refused('SNAPSHOT_GRAPH', 'A sealed page cannot refer to itself.');
    return atomic(() => {
      upload(id, principal);
      const saved = db.prepare('SELECT * FROM page_object WHERE id=?').get(identity);
      if (saved && (saved.sequence !== object.sequence || saved.children !== children || !Buffer.from(saved.payload).equals(Buffer.from(object.bytes)))) throw new Refused('SNAPSHOT_PAGE_CONFLICT', 'Retry the original bytes and references for this content id.');
      if (!saved) {
        checkBudget(object.bytes.byteLength + Buffer.byteLength(children));
        db.prepare('INSERT INTO page_object VALUES (?,?,?,?,?)').run(identity, object.sequence, object.bytes, children, clock());
      }
      db.prepare('INSERT OR IGNORE INTO page_upload_object VALUES (?,?)').run(id, identity);
      db.prepare('UPDATE page_upload SET expires=? WHERE id=?').run(clock() + UPLOAD_MS, id);
      return { id: identity, stored: !saved };
    });
  }

  /** Verify every referenced object before atomically publishing the journal's new coverage cursor. */
  function publish(id, principal, rawReference, publishHead) {
    const reference = pageReference(rawReference);
    return atomic(() => {
      const staged = upload(id, principal);
      if (reference.sequence !== staged.sequence) throw new Refused('BAD_SEQUENCE', 'Publish the coverage sequence named when this upload began.');
      const root = db.prepare('SELECT sequence,payload FROM page_object WHERE id=?').get(reference.id);
      if (!root || root.sequence !== reference.sequence) {
        const error = new Refused('SNAPSHOT_PAGE_MISSING', 'Upload this snapshot’s sealed root before publishing it.');
        error.page = reference.id;
        throw error;
      }
      graph([reference.id], true);
      const result = publishHead(reference, Buffer.from(root.payload));
      if (result && typeof result.then === 'function') throw new Refused('RELAY_CONFIG', 'Commit the journal head synchronously before finishing publication.');
      db.prepare('DELETE FROM page_upload WHERE id=?').run(id);
      return result;
    });
  }

  /** Pin the journal's current root before returning it, so a concurrent publication cannot delete an in-flight read. */
  function pin(principal, rawReference) {
    const owner = principalKey(principal);
    const reference = pageReference(rawReference);
    return atomic(() => {
      graph([reference.id], true);
      const existing = db.prepare('SELECT id FROM page_pin WHERE principal=? AND root=?').get(owner, reference.id);
      const id = existing?.id ?? randomUUID();
      db.prepare('INSERT INTO page_pin VALUES (?,?,?,?,?) ON CONFLICT(principal,root) DO UPDATE SET reference=excluded.reference,expires=excluded.expires').run(id, owner, reference.id, JSON.stringify(reference), clock() + READ_MS);
      return { id, expires: clock() + READ_MS };
    });
  }

  /** Renew a principal's existing read pin; authorization must still run again for every HTTP request. */
  function get(id, principal, rawObject, parents = []) {
    const identity = objectId(rawObject);
    return atomic(() => {
      const saved = db.prepare('SELECT * FROM page_pin WHERE id=?').get(String(id));
      if (!saved || saved.principal !== principalKey(principal) || saved.expires <= clock()) throw new Refused('SNAPSHOT_READ_EXPIRED', 'Read the current snapshot head again before fetching its sealed pages.');
      if (!Array.isArray(parents) || parents.length > MAX_DEPTH) throw new Refused('BAD_PAGE_PATH', 'Fetch a page through the references of the pinned snapshot.');
      const path = [...parents.map(objectId), identity];
      if (path[0] !== saved.root || new Set(path).size !== path.length) throw new Refused('BAD_PAGE_PATH', 'Fetch a page through the references of the pinned snapshot.');
      for (let index = 0; index < path.length - 1; index += 1) {
        const parent = db.prepare('SELECT children FROM page_object WHERE id=?').get(path[index]);
        if (!parent || !childrenOf(parent).includes(path[index + 1])) throw new Refused('BAD_PAGE_PATH', 'This sealed page is not referenced by the pinned snapshot.');
      }
      const row = db.prepare('SELECT sequence,payload,children FROM page_object WHERE id=?').get(identity);
      if (!row) throw new Refused('SNAPSHOT_PAGE_MISSING', 'Refresh the snapshot head before retrying this sealed page.');
      db.prepare('UPDATE page_pin SET expires=? WHERE id=?').run(clock() + READ_MS, id);
      return { id: identity, sequence: row.sequence, bytes: Buffer.from(row.payload), children: childrenOf(row) };
    });
  }

  /** Collect only unreachable objects, preserving current journal roots, all live readers and unfinished uploads. */
  function prune(currentRoots) {
    if (!Array.isArray(currentRoots)) throw new Refused('RELAY_CONFIG', 'Supply the journal’s authoritative current page roots before collecting storage.');
    return atomic(() => {
      db.prepare('DELETE FROM page_upload WHERE expires<=?').run(clock());
      db.prepare('DELETE FROM page_pin WHERE expires<=?').run(clock());
      const keep = graph([...currentRoots, ...db.prepare('SELECT root FROM page_pin').all().map(row => row.root)], true);
      const staged = graph(db.prepare('SELECT object FROM page_upload_object').all().map(row => row.object), false);
      for (const id of staged) keep.add(id);
      const remove = db.prepare('DELETE FROM page_object WHERE id=?');
      let deleted = 0;
      for (const row of db.prepare('SELECT id FROM page_object').all()) {
        if (!keep.has(row.id)) { remove.run(row.id); deleted += 1; }
      }
      return { deleted };
    });
  }

  /** Account for logical opaque payload and public index bytes; SQLite allocation overhead is not a board limit. */
  function usage() {
    clock();
    return db.prepare('SELECT COUNT(*) AS objects,COALESCE(SUM(length(payload)+length(children)),0) AS bytes FROM page_object').get();
  }

  /** Close exactly this store; repeated shutdown is harmless. */
  function close() { if (!closed) { if (ownsDatabase) db.close(); closed = true; } }
  return { begin, resume, put, publish, pin, get, prune, usage, close, file };
}
