import { effectiveItemHead } from '../../../../../verify/index.js';
import { isRecordedConflictContext } from '../../../../../state/index.js';
/** Board-bound computed conflict evidence is verified against immutable Git commits before sealing and on replay [V4,H16]. */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { repoInfo } from '../../../../../git/index.js';
import { recordedTrunkMerge } from '../../../../../merge/index.js';
import { trunkMerge } from '../../../../../merge/index.js';
import { refuseRecordedHistoryOverrides } from '../../../../../merge/index.js';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { Refused } from '../../../../../kernel/index.js';

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const ID = /^[a-f0-9-]{36}$/u;

/** Read the canonical immutable record, rejecting altered, unknown or malformed fields. */
export function computedConflictFields(value) {
  if (!value || ![1, 2, 3, 4].includes(value.version) || !ID.test(value.id ?? '') || !/^[a-f0-9]{32}$/u.test(value.board ?? '')
    || !Number.isSafeInteger(value.item) || value.item < 1 || typeof value.actor !== 'string' || !value.actor || value.actor.length > 128 || /[\r\n\0]/u.test(value.actor)
    || !Number.isSafeInteger(value.submission) || value.submission < 1
    || !SHA.test(value.head ?? '') || !SHA.test(value.trunk ?? '') || !Array.isArray(value.files)
    || !value.files.length || value.files.length > 4096 || value.files.some(file => typeof file !== 'string' || !file || file.length > 4096 || file.includes('\0'))
    || new Set(value.files).size !== value.files.length || typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))) return null;
  const fields = { version: value.version, id: value.id, board: value.board, item: value.item, actor: value.actor,
    head: value.head, trunk: value.trunk, files: [...value.files], at: value.at, submission: value.submission };
  const digest = createHash('sha256').update(JSON.stringify(fields)).digest('hex');
  return value.digest === digest && Object.keys(value).length === Object.keys(fields).length + 1 ? { ...fields, digest } : null;
}

const VERIFIED_OBJECTS = new WeakMap();

/** Locate this replica's object store; private replicas may use their registered repository's immutable objects. */
function objectStore(board) {
  const file = board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  const common = file ? dirname(dirname(file)) : null;
  if (common && existsSync(join(common, 'objects'))) return common;
  const root = board.db.prepare("SELECT agent_path FROM agent WHERE agent_id='coordinator'").get()?.agent_path;
  try { if (root) return repoInfo(root).commonDir; } catch { /* Missing local objects are a recoverable replay refusal. */ }
  throw new Refused('MERGE_CHECK_FAILED', 'fetch the recorded submitted and trunk commits into this replica repository before resuming the move');
}

/** Verify immutable objects before advancing a relay position; missing objects must leave it retryable after fetch. */
export function requireComputedConflictObjects(board, receipt) {
  const fields = computedConflictFields(receipt);
  if (!fields) return null;
  const gitDirectory = objectStore(board);
  refuseRecordedHistoryOverrides(gitDirectory);
  let cache = VERIFIED_OBJECTS.get(board);
  if (!cache) { cache = new Map(); VERIFIED_OBJECTS.set(board, cache); }
  const key = `${fields.version}:${fields.head}:${fields.trunk}`;
  if (!cache.has(key)) cache.set(key, recordedTrunkMerge(gitDirectory, fields.head, fields.trunk, { version: fields.version }));
  return cache.get(key);
}

/** A self-hash only detects changes; actual immutable Git conflict verification supplies authority. */
export function requireComputedConflict(board, receipt) {
  const fields = computedConflictFields(receipt);
  if (!fields || JSON.stringify(requireComputedConflictObjects(board, fields)) !== JSON.stringify(fields.files)) {
    throw new Refused('COORDINATOR_ONLY', 'automatic return requires the conflicting files computed from its recorded head and trunk');
  }
  return fields;
}

/** Fresh authoring must use the current trunk; recorded acknowledgments return before this mutation path. */
function requireCurrentConflict(board, fields) {
  if (fields.version !== 4) throw new Refused('COORDINATOR_ONLY', 'fresh automatic returns need current mechanical conflict evidence; compute a new return');
  const root = board.db.prepare("SELECT agent_path FROM agent WHERE agent_id='coordinator'").get()?.agent_path;
  if (!root) throw new Refused('COORDINATOR_ONLY', 'fresh automatic return needs the registered native trunk');
  const current = trunkMerge(root, fields.head);
  if (current.commit !== fields.trunk || JSON.stringify(current.files) !== JSON.stringify(fields.files)) {
    throw new Refused('COORDINATOR_ONLY', 'fresh automatic return must use the current trunk; compute a new return before sending it');
  }
}

/** Bind recorded evidence to this board's current submitted item and actual actor, on every replica. */
function bindingProblem(board, item, actor, receipt) {
  const fields = computedConflictFields(receipt);
  const identity = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='board_id'").get()?.meta_value;
  const submission = board.db.prepare("SELECT event_id FROM event WHERE item_id=? AND event_kind='submit' ORDER BY event_id DESC LIMIT 1").get(item.item_id)?.event_id;
  if (!fields || fields.submission !== submission || fields.board !== identity || fields.item !== item.item_id || fields.actor !== actor
    || fields.head !== (effectiveItemHead(board, item) ?? item.item_commit) || item.item_status !== 'submitted') return new Refused('COORDINATOR_ONLY',
    'automatic conflict evidence must name this board, actor and current submitted head');
  return null;
}

/** Check missing objects only after immutable record identity matches the requested current item. */
export function preflightComputedConflict(board, id, actor, receipt) {
  const item = board.db.prepare('SELECT * FROM item WHERE item_id=?').get(id);
  if (item && !bindingProblem(board, item, actor, receipt)) requireComputedConflictObjects(board, receipt);
}

/** Verify the same actual immutable conflict on direct calls and on every replaying replica. */
export function computedConflictProblem(board, item, actor, receipt) {
  const problem = bindingProblem(board, item, actor, receipt);
  if (problem) return problem;
  const fields = requireComputedConflict(board, receipt);
  if (!isRecordedConflictContext(board, item, actor, receipt)) {
    // Checked inside the reopen write, so a reservation taken after the caller's snapshot still holds (#1356).
    // A recorded replay skips it, like the current-conflict check, so history replays unchanged.
    const held = heldReviewProblem(board, item, actor);
    if (held) return held;
    requireCurrentConflict(board, fields);
  }
  return null;
}

/** Refuse an automatic return while a different reviewer holds a live reservation on the head [C7,V4]. */
function heldReviewProblem(board, item, actor) {
  const holder = item.item_review_by;
  if (!holder || holder === actor || !(Date.parse(item.item_review_until ?? '') > board.clock.now().getTime())) return null;
  return new Refused('REVIEW_HELD', `${holder} holds the review of #${item.item_id} until ${item.item_review_until}; its conflict return waits for that review to end; take another: pullboard next --verify`);
}

/** Derive merge fields from canonical evidence; malformed evidence remains a merge request that authority refuses. */
export function conflictValue(receipt, asserted) {
  if (receipt === undefined) return asserted;
  const fields = computedConflictFields(receipt);
  return fields ? { files: fields.files, trunk: fields.trunk } : {};
}

/** Refuse a prepared record that is not the current requested item and actual sending actor. */
export function requirePreparedComputedConflict(board, id, actor, receipt) {
  const item = board.db.prepare('SELECT * FROM item WHERE item_id=?').get(id);
  const problem = item ? bindingProblem(board, item, actor, receipt) : new Refused('COORDINATOR_ONLY', 'automatic conflict evidence needs the current submitted item');
  if (problem) throw problem;
  const fields = requireComputedConflict(board, receipt);
  requireCurrentConflict(board, fields);
  return fields;
}
