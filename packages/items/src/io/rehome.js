import { saveCheckTiming } from "../logic/check/timing.js";
/** Durable source tombstones and idempotent destination application for cross-board re-homing [E15,H16]. */
import { createHash } from 'node:crypto';
import { IN_STATE } from "../../../state/index.js";
import { MOVES } from "../../../state/index.js";
import { REFERENCE_ENGINE } from "../../../state/light.js";
import { handledReferences } from "../../../spec/index.js";
import { validateReferences } from "../../../spec/index.js";
import { Refused } from "../../../kernel/index.js";

const REHOME_IMPORT_MOVE = MOVES.find(move => move.verb === 'rehomeImport');

/** Name the permanent redirect row for one retained source item ID. */
const redirectKey = id => `item_redirect:${id}`;
/** Name one destination receipt by source board identity and immutable source MOVEID. */
const applicationKey = (source, move) => `item_rehome:${source}:${move}`;
/** Name the destination's durable ID reservation by its source identity. */
const reservationKey = (source, move) => `item_rehome_reservation:${source}:${move}`;

/** Find the ordered destination event that makes a reserved ID portable across replicas. */
function reservationEvent(board, sourceBoardId, sourceMoveId, destinationBoardId, destinationItemId) {
  return board.db.prepare(`SELECT event_id FROM event WHERE event_kind='rehome_reserved'
    AND json_extract(event_detail,'$.sourceBoardId')=? AND json_extract(event_detail,'$.sourceMoveId')=?
    AND json_extract(event_detail,'$.destinationBoardId')=? AND json_extract(event_detail,'$.destinationItemId')=?
    ORDER BY event_id LIMIT 1`).get(sourceBoardId, sourceMoveId, destinationBoardId, destinationItemId);
}

/** Encode exact JSON records with stable object-key order before binding a replay identity. */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

/** Bind one source MOVEID to the full immutable move content. */
function digest(value) { return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }

/** Keep the result hash stable while appending the ordered event that names the result. */
function moveDigest(value) {
  const { digest: ignoredDigest, sourceReceipt: ignoredSourceReceipt, deliveryStatus: ignoredDeliveryStatus, ...content } = value;
  return digest(content);
}

/** Match retries on the exact receipt pointer as well as the sealed move result. */
function sourceBinding(value) {
  const { digest: ignoredDigest, deliveryStatus: ignoredDeliveryStatus, ...content } = value;
  return digest(content);
}

/** Carry only a current checked-reference attestation from the source board's ordered receipt. */
function checkedReferenceReceipt(board, id, item) {
  const rows = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key GLOB 'relay_receipt_*'").all();
  const candidates = [];
  for (const row of rows) {
    let receipt;
    try { receipt = JSON.parse(row.meta_value); } catch { return null; }
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || !receipt.move
        || !receipt.outcome || typeof receipt.outcome !== 'object' || Array.isArray(receipt.outcome)) return null;
    if (receipt.outcome.error) continue;
    let move;
    try { move = JSON.parse(receipt.move); } catch { return null; }
    if (!move || typeof move !== 'object' || Array.isArray(move)) return null;
    if (!['addItem', 'editItem'].includes(move.operation)) continue;
    const index = move.operation === 'addItem' ? 0 : 1;
    const args = move.args?.[index];
    const itemId = move.operation === 'addItem' ? receipt.outcome.result : move.args?.[0];
    if (itemId !== id || typeof args?.brief !== 'string') continue;
    if (!Array.isArray(receipt.outcome.events)) return null;
    const event = receipt.outcome.events.find(entry => entry.item_id === id
      && entry.event_kind === (move.operation === 'addItem' ? 'add' : 'edit'));
    if (!event) continue;
    candidates.push({ sequence: receipt.sequence, moveId: move.id, engine: move.engine,
      operation: move.operation, itemId: id, eventId: event.event_id, brief: args.brief,
      actor: move.operation === 'addItem' ? args.by : args.agentId,
      authority: args.referenceAuthority, authors: args.referenceAuthors });
  }
  if (candidates.some(candidate => !Number.isSafeInteger(candidate.eventId) || candidate.eventId < 1)) return null;
  const latest = candidates.sort((a, b) => b.eventId - a.eventId)[0];
  return latest?.brief === item.item_brief && Number.isSafeInteger(latest.engine)
    && latest.engine >= REFERENCE_ENGINE && Number.isSafeInteger(latest.sequence) && latest.sequence > 0
    && Number.isSafeInteger(latest.eventId) && latest.eventId > 0 && latest.authority === 'person'
    && Array.isArray(latest.authors) && ['coordinator', 'person'].includes(latest.actor)
    ? latest : null;
}

/** Check the mover-attested source receipt before forwarding a handled marker. */
function carriesCheckedReferences(record, source) {
  const proof = record.referenceProof;
  return Boolean(proof && proof.itemId === record.sourceItemId && proof.brief === source.item_brief
    && Number.isSafeInteger(proof.engine) && proof.engine >= REFERENCE_ENGINE
    && ['addItem', 'editItem'].includes(proof.operation)
    && typeof proof.moveId === 'string' && Number.isSafeInteger(proof.sequence) && proof.sequence > 0
    && Number.isSafeInteger(proof.eventId) && proof.eventId > 0
    && proof.authority === 'person' && ['coordinator', 'person'].includes(proof.actor) && Array.isArray(proof.authors)
    && handledReferences(source.item_brief).length > 0);
}

/** A stale or incomplete source attestation loses only its handled marker, never its text. */
function validReferenceProof(record, source) {
  if (!carriesCheckedReferences(record, source)) return false;
  try {
    validateReferences(source.item_brief, { actor: record.referenceProof.actor,
      authors: record.referenceProof.authors, authority: record.referenceProof.authority });
    return true;
  } catch {
    return false;
  }
}

/** Keep reference text and rationale while removing handles that lack a current checked source receipt. */
function unhandleReferences(brief) {
  return brief.split('\n').map(line => /^\s*Reference\s*:/iu.test(line)
    ? line.replace(/\s+@[A-Za-z0-9][A-Za-z0-9-]{0,38}(?=\s*$)/u, '') : line).join('\n');
}

/** Reserve a destination ID as its own ordered, replayable destination-board operation. */
export function reserveRehomeItemId(board, sourceBoardId, sourceMoveId, options, { atomic, boardId, logEvent }) {
  if (!/^[0-9a-f]{32}$/u.test(sourceBoardId ?? '') || !/^[A-Za-z0-9_-]{1,80}$/u.test(sourceMoveId ?? '')) {
    throw new Refused('REHOME_FORMAT', 'restore the exact source move identity before reserving a destination ID');
  }
  const agentId = options?.agentId;
  if (typeof agentId !== 'string' || agentId !== 'coordinator'
      && !board.db.prepare('SELECT 1 FROM agent WHERE agent_id=?').get(agentId)) {
    throw new Refused('NOT_JOINED', 'join this destination board before reserving its item ID');
  }
  return atomic(board, () => {
    const key = reservationKey(sourceBoardId, sourceMoveId);
    const previous = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(key);
    if (previous) {
      const reservation = JSON.parse(previous.meta_value);
      if (reservation.sourceBoardId !== sourceBoardId || reservation.moveId !== sourceMoveId
          || reservation.destinationBoardId !== boardId(board)
          || !Number.isSafeInteger(reservation.destinationItemId) || reservation.destinationItemId < 1) {
        throw new Refused('REHOME_CONFLICT', 'this source move ID already has a different destination reservation');
      }
      if (!reservationEvent(board, sourceBoardId, sourceMoveId, boardId(board), reservation.destinationItemId)) {
        logEvent(board, agentId, 'rehome_reserved', null, { sourceBoardId, sourceMoveId,
          destinationBoardId: boardId(board), destinationItemId: reservation.destinationItemId });
      }
      return reservation.destinationItemId;
    }
    const max = Number(board.db.prepare('SELECT COALESCE(MAX(item_id),0) AS value FROM item').get().value);
    const sequence = board.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='item'").get()?.seq ?? 0;
    const id = Math.max(max, sequence) + 1;
    const updated = board.db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='item'").run(id);
    if (updated.changes === 0) board.db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('item',?)").run(id);
    board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?)').run(key, JSON.stringify({
      sourceBoardId, moveId: sourceMoveId, destinationBoardId: boardId(board), destinationItemId: id,
    }));
    logEvent(board, agentId, 'rehome_reserved', null, { sourceBoardId, sourceMoveId, destinationBoardId: boardId(board), destinationItemId: id });
    return id;
  });
}

/** Read the immutable source redirect, or null before the item has moved. */
export function itemRedirect(board, id) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(redirectKey(id));
  return row ? JSON.parse(row.meta_value) : null;
}

/** Read imported-source attribution without presenting it as a destination-board verdict. */
export function rehomeImport(board, id) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(`rehome_import:${id}`);
  return row ? JSON.parse(row.meta_value) : null;
}

/** Find the one destination item already applied for a source item on this destination board. */
export function rehomeDestinationItemId(board, sourceBoardId, sourceItemId, boardId) {
  if (!/^[0-9a-f]{32}$/u.test(sourceBoardId ?? '') || !Number.isSafeInteger(sourceItemId) || sourceItemId < 1) return null;
  const prefix = `item_rehome:${sourceBoardId}:`;
  const rows = board.db.prepare('SELECT meta_key,meta_value FROM board_meta WHERE meta_key>=? AND meta_key<? ORDER BY meta_key')
    .all(prefix, `${prefix}\uffff`);
  const matches = rows.map(row => JSON.parse(row.meta_value)).filter(row => row.sourceBoardId === sourceBoardId
    && row.sourceItemId === sourceItemId && row.destinationBoardId === boardId(board));
  if (matches.length > 1 || matches.some(row => row.destinationItemId !== matches[0]?.destinationItemId)) {
    throw new Refused('REHOME_CONFLICT', 'one source item has conflicting destination receipts; preserve both board records');
  }
  return matches[0]?.destinationItemId ?? null;
}

/** Write one source-ordered tombstone while retaining enough source content for a safe retry. */
export function rehomeItem(board, id, options, { atomic, boardId, current, itemById, logEvent, itemReviewPolicy, twoTierReviews }) {
  if (!options || typeof options !== 'object' || !/^[A-Za-z0-9_-]{1,80}$/u.test(options.sourceMoveId ?? '')
      || !/^[0-9a-f]{32}$/u.test(options.destinationBoardId ?? '')
      || !Number.isSafeInteger(options.destinationItemId) || options.destinationItemId < 1) {
    throw new Refused('REHOME_FORMAT', 'refresh the local board inventory and move to one exact destination board');
  }
  return atomic(board, () => {
    const saved = itemRedirect(board, id);
    if (saved) {
      if (saved.moveId !== options.sourceMoveId || saved.destinationBoardId !== options.destinationBoardId
          || saved.destinationItemId !== options.destinationItemId || saved.agentId !== options.agentId) {
        throw new Refused('ITEM_MOVED', `item #${id} already moved to ${saved.destinationHandle}#${saved.destinationItemId}`);
      }
      return saved;
    }
    const item = current(board, itemById(board, id));
    if (typeof options.agentId !== 'string' || options.agentId !== 'coordinator'
        && !board.db.prepare('SELECT 1 FROM agent WHERE agent_id=?').get(options.agentId)) {
      throw new Refused('NOT_JOINED', 'join this source board before moving one of its items');
    }
    if (!['open', 'verified'].includes(item.item_status)) {
      throw new Refused('REHOME_STATE', `item #${id} is ${item.item_status}; move open or verified items only`);
    }
    const sourceBoardId = boardId(board);
    if (sourceBoardId === options.destinationBoardId) throw new Refused('REHOME_SAME_BOARD', 'choose a different local board');
    const verdicts = board.db.prepare('SELECT * FROM verdict WHERE item_id=? ORDER BY verdict_id').all(id);
    const content = { ...item, verdicts };
    const record = { version: 1, moveId: options.sourceMoveId, sourceBoardId, sourceItemId: id,
      destinationBoardId: options.destinationBoardId, destinationItemId: options.destinationItemId,
      agentId: options.agentId, item: content };
    const reviewPolicy = itemReviewPolicy(board, id);
    if (twoTierReviews(board) && reviewPolicy.tier === 'strict') {
      const { tier, ...storedPolicy } = reviewPolicy;
      record.reviewPolicy = storedPolicy;
    }
    const referenceProof = checkedReferenceReceipt(board, id, item);
    if (referenceProof) record.referenceProof = referenceProof;
    if (typeof options.destinationHandle === 'string') record.destinationHandle = options.destinationHandle;
    if (typeof options.sourceHandle === 'string') record.sourceHandle = options.sourceHandle;
    record.digest = moveDigest(record);
    logEvent(board, options.agentId, 'rehome', id, { moveId: options.sourceMoveId,
      sourceBoardId, sourceItemId: id, destinationBoardId: options.destinationBoardId,
      destinationItemId: options.destinationItemId, resultDigest: record.digest });
    record.sourceReceipt = { eventId: board.lastEvent.event_id, resultDigest: record.digest };
    board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?)').run(redirectKey(id), JSON.stringify(record));
    return record;
  });
}

/** Apply one source record once; replay returns the original destination ID without another item. */
export function applyRehomeItem(board, request, { atomic, boardId, logEvent, moveItem, validateItemAddition, now, reviewPolicyChange, saveItemReviewPolicy }) {
  const record = request?.record;
  const agentId = request?.destinationAgentId ?? request?.agentId;
  if (!record || record.version !== 1 || !/^[A-Za-z0-9_-]{1,80}$/u.test(record.moveId ?? '')
      || !/^[0-9a-f]{32}$/u.test(record.sourceBoardId ?? '') || !/^[0-9a-f]{32}$/u.test(record.destinationBoardId ?? '')
      || !Number.isSafeInteger(record.sourceItemId) || !Number.isSafeInteger(record.destinationItemId)
      || !record.item || typeof record.item !== 'object' || !['open', 'verified'].includes(record.item.item_status)
      || !Number.isSafeInteger(record.sourceReceipt?.eventId) || record.sourceReceipt.eventId < 1
      || record.sourceReceipt.resultDigest !== record.digest) {
    throw new Refused('REHOME_FORMAT', 'restore the exact source move record before applying it');
  }
  if (boardId(board) !== record.destinationBoardId) throw new Refused('REHOME_DESTINATION', 'apply the source move on its named destination board');
  if (record.digest !== moveDigest(record)) throw new Refused('REHOME_FORMAT', 'restore the exact source move record before applying it');
  return atomic(board, () => {
    const key = applicationKey(record.sourceBoardId, record.moveId);
    const binding = sourceBinding(record);
    const applied = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(key);
    if (applied) {
      const saved = JSON.parse(applied.meta_value);
      if (saved.binding !== binding) throw new Refused('REHOME_CONFLICT', 'the source move ID already names different destination content');
      return saved.destinationItemId;
    }
    if (typeof agentId !== 'string' || agentId !== 'coordinator'
        && !board.db.prepare('SELECT 1 FROM agent WHERE agent_id=?').get(agentId)) {
      throw new Refused('NOT_JOINED', 'join this destination board before applying its source move');
    }
    const source = record.item;
    const retainHandledReferences = validReferenceProof(record, source);
    let destinationBrief = source.item_brief;
    let referenceAuthors;
    let referenceAuthority;
    if (handledReferences(source.item_brief).length) {
      if (retainHandledReferences) {
        referenceAuthors = record.referenceProof.authors;
        referenceAuthority = record.referenceProof.authority;
      } else destinationBrief = unhandleReferences(destinationBrief);
    }
    const keyReservation = reservationKey(record.sourceBoardId, record.moveId);
    const reservation = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get(keyReservation);
    const reserved = reservation ? JSON.parse(reservation.meta_value) : null;
    if (reserved && (reserved.destinationBoardId !== record.destinationBoardId || reserved.destinationItemId !== record.destinationItemId)) {
      throw new Refused('REHOME_CONFLICT', 'the source move differs from its durable destination ID reservation');
    }
    if (!reserved || reserved.sourceBoardId !== record.sourceBoardId || reserved.moveId !== record.moveId
        || !reservationEvent(board, record.sourceBoardId, record.moveId, record.destinationBoardId, record.destinationItemId)) {
      throw new Refused('REHOME_ID', 'reserve this destination ID through its ordered destination operation, then retry the same source MOVEID');
    }
    if (record.item.verdicts !== undefined && !Array.isArray(record.item.verdicts)) throw new Refused('REHOME_FORMAT', 'restore the source item verdict history before applying its move');
    let accepted = null;
    if (source.item_status === 'verified') {
      accepted = (record.item.verdicts ?? []).find(verdict => verdict.verdict_decision === 'ACCEPT'
        && verdict.verdict_commit === source.item_commit && verdict.verdict_digest === source.item_frozen_digest
        && verdict.verdict_by === source.item_verified_by && verdict.verdict_by !== source.item_built_by);
      if (!accepted || source.item_verdict !== 'ACCEPT' || !source.item_commit || !source.item_frozen_digest || !source.item_verified_by) {
        throw new Refused('REHOME_VERDICT', 'the source verified item has no exact current ACCEPT reference to carry');
      }
    }
    const parentId = source.item_parent_id === null ? null : rehomeDestinationItemId(board, record.sourceBoardId, source.item_parent_id, boardId);
    const after = source.item_after ? source.item_after.split(',').map(value => value.trim()).map(value => {
      if (/^\d+$/u.test(value)) return rehomeDestinationItemId(board, record.sourceBoardId, Number(value), boardId);
      return /^[^\s#]+#\d+$/u.test(value) ? value : null;
    }) : [];
    if (source.item_parent_id !== null && !parentId || after.some(id => id === null || id === undefined)) {
      throw new Refused('REHOME_LINKS', 'move each parent or wait item to this destination first, then retry the same source MOVEID');
    }
    if (source.item_check_timing !== undefined && typeof source.item_check_timing !== 'boolean') throw new Refused('REHOME_FORMAT', 'source check timing must retain its exact boolean declaration');
    if (record.reviewPolicy && record.reviewPolicy.version !== 1) throw new Refused('REHOME_FORMAT', 'use a destination supporting the exact source review policy version');
    const importedReviewPolicy = record.reviewPolicy ? reviewPolicyChange(board, null, record.reviewPolicy) : null;
    const addition = { by: agentId, ...(importedReviewPolicy ? { sensitive: importedReviewPolicy.sensitive, reviewFamily: importedReviewPolicy.reviewFamily } : {}), lane: source.item_lane, title: source.item_title,
      criterion: source.item_criterion, parentId, after, brief: destinationBrief,
      route: source.item_route, check: source.item_check, referenceAuthors, referenceAuthority };
    const { command, cleanTitle } = validateItemAddition(board, { ...addition, parentId: null, after: [], by: agentId }, {
      sourceMove: { agentId, moveId: record.moveId, digest: record.digest, sourceReceipt: record.sourceReceipt,
        item: source, ...(retainHandledReferences ? { referenceProof: record.referenceProof } : {}) },
    });
    if (command !== source.item_check) throw new Refused('REHOME_CHECK', 'the destination must accept the source item check unchanged');
    if (parentId !== null) {
      const parent = board.db.prepare('SELECT item_lane FROM item WHERE item_id=?').get(parentId);
      if (!parent || parent.item_lane !== source.item_lane || itemRedirect(board, parentId)) {
        throw new Refused('REHOME_LINKS', 'move the current parent item to this destination first, then retry the same source MOVEID');
      }
    }
    for (const dependency of after) {
      if (typeof dependency === 'string') continue;
      const item = board.db.prepare('SELECT item_status FROM item WHERE item_id=?').get(dependency);
      if (!item || item.item_status === 'withdrawn' || itemRedirect(board, dependency)) {
        throw new Refused('REHOME_LINKS', 'move the current wait items to this destination first, then retry the same source MOVEID');
      }
    }
    const occupied = board.db.prepare('SELECT 1 FROM item WHERE item_id=?').get(record.destinationItemId);
    if (occupied) {
      throw new Refused('REHOME_ID', 'the reserved destination item ID is already in use; keep the same source MOVEID and resolve the collision before retrying');
    }
    const at = now(board);
    const verifiedReference = accepted ? {
      decision: 'ACCEPT', commit: accepted.verdict_commit, digest: accepted.verdict_digest,
      by: accepted.verdict_by, sourceVerdictId: accepted.verdict_id,
    } : null;
    const importReference = { sourceBoardId: record.sourceBoardId, sourceItemId: record.sourceItemId,
      sourceHandle: record.sourceHandle ?? record.sourceBoardId, sourceReceipt: record.sourceReceipt,
      sourceMoveDigest: record.digest, moveId: record.moveId, attestedBy: agentId,
      sourceStatus: source.item_status, sourceVerdicts: record.item.verdicts ?? [],
      ...(verifiedReference ? { verdict: verifiedReference } : {}) };
    board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?)')
      .run(`rehome_import:${record.destinationItemId}`, JSON.stringify(importReference));
    const itemColumns = `item_id,item_parent_id,item_lane,item_title,item_criterion,item_spec_ids,item_after,item_brief,item_route,item_check,
      item_created_by,item_created_at,item_updated_at,item_status,item_frozen,item_frozen_digest,item_built_by,item_builder_family,item_commit,item_tree,item_verdict,item_verified_by`;
    const result = board.db.prepare(`INSERT INTO item (${itemColumns}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(record.destinationItemId, parentId, source.item_lane, cleanTitle, source.item_criterion, source.item_spec_ids, after.join(','), destinationBrief,
        source.item_route, source.item_check, source.item_created_by, source.item_created_at, at, 'open',
        source.item_frozen, source.item_frozen_digest, source.item_built_by, source.item_builder_family,
        source.item_commit, source.item_tree, source.item_verdict, source.item_verified_by);
    if (Number(result.lastInsertRowid) !== record.destinationItemId) throw new Refused('REHOME_ID', 'the reserved destination item ID is no longer available');
    saveCheckTiming(board, record.destinationItemId, source.item_check_timing);
    saveItemReviewPolicy(board, record.destinationItemId, importedReviewPolicy);
    const inserted = itemByIdForRehome(board, record.destinationItemId);
    if (accepted) moveItem(board, record.destinationItemId, 'rehomeImport', {
      transition: REHOME_IMPORT_MOVE,
      checks: {
        joined: null,
        [IN_STATE]: item => item.item_status === 'open' ? null : new Refused('REHOME_VERDICT', 'restore the imported item to its original open state before carrying its ACCEPT reference'),
        sourceAcceptance: item => importReference.attestedBy === agentId
          && importReference.moveId === record.moveId && importReference.sourceMoveDigest === record.digest
          && importReference.sourceReceipt?.eventId === record.sourceReceipt.eventId
          && item.item_commit === accepted.verdict_commit
          && item.item_frozen_digest === accepted.verdict_digest && item.item_verified_by === accepted.verdict_by
          && item.item_built_by !== accepted.verdict_by && typeof accepted.verdict_note === 'string'
          ? null : new Refused('REHOME_VERDICT', 'keep the exact source ACCEPT, frozen digest, commit, builder and verifier reference together'),
        atSubmittedCommit: item => item.item_commit === accepted.verdict_commit ? null : new Refused('NOT_AT_COMMIT', 'preserve the source ACCEPT commit on the imported item'),
        notBuilder: item => item.item_built_by !== accepted.verdict_by ? null : new Refused('SELF_VERIFY', 'preserve an independent source verifier reference'),
        criterionUnchanged: item => item.item_frozen_digest === accepted.verdict_digest ? null : new Refused('CRITERIA_CHANGED', 'preserve the exact frozen digest accepted on the source board'),
        proofNoted: () => typeof accepted.verdict_note === 'string' && accepted.verdict_note.trim()
          ? null : new Refused('PROOF_REQUIRED', 'preserve the source verifier note with the ACCEPT reference'),
      },
      set: () => ({ item_verified_by: accepted.verdict_by, item_commit: accepted.verdict_commit }),
    });
    board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?)').run(key, JSON.stringify({
      sourceBoardId: record.sourceBoardId, sourceItemId: record.sourceItemId, moveId: record.moveId,
      destinationBoardId: record.destinationBoardId, destinationItemId: record.destinationItemId, binding,
      attestedBy: agentId, sourceReceipt: record.sourceReceipt,
      ...(verifiedReference ? { verifiedReference } : {}),
    }));
    logEvent(board, agentId, accepted ? 'rehome_import' : 'rehome_applied', record.destinationItemId, {
      sourceBoardId: record.sourceBoardId, sourceMoveId: record.moveId, sourceItemId: record.sourceItemId,
      sourceReceipt: record.sourceReceipt, resultDigest: record.digest, attestedBy: agentId,
      ...(verifiedReference ? { sourceVerdict: verifiedReference.sourceVerdictId, commit: verifiedReference.commit, verifier: verifiedReference.by } : {}),
    });
    return inserted.item_id;
  });
}

/** Return the inserted destination row without exposing a separate read API dependency. */
function itemByIdForRehome(board, id) {
  const item = board.db.prepare('SELECT * FROM item WHERE item_id=?').get(id);
  if (!item) throw new Refused('REHOME_ID', 'the destination item was not created; preserve the source move and retry its application');
  return item;
}
