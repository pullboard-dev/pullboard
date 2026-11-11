/**
 * Shared board links retain bilateral consent, current generations and a multiple-parent DAG [E32,H16,H17].
 *
 * Resolve BoardRefs through an explicitly authorized inventory, then approve the canonical record
 * with each endpoint's caller-configured signer authority. applyBoardLink persists that accepted
 * record on a real board/catalog; readBoardLinks is detached storage, not an authority assertion.
 * Operations call authorizeBoardLink again, so restored records and asynchronous revocations do
 * not inherit trust from a path, handle, registry entry or previous successful read.
 *
 * boardStateAnnouncement is only the common stripping serializer. Actual delivery is provided
 * by board-link-relay.js with a board-bound authenticated transport and a separately provisioned
 * board-link-envelope.js capability. Neither repository enrollment nor a relay bearer token
 * replaces the two board approvals. There is no CLI, UI or automatic key-distribution policy here.
 */
import { Refused } from "../../../../kernel/index.js";
import { atomic } from "./event/log.js";
import { logEvent } from "./event/log.js";
import { boardLinkBody } from "../../../../kernel/index.js";
import { boardLinkRecord } from "../../../../kernel/index.js";
import { boardLinkSigningText } from "../../../../kernel/index.js";
import { boardLinkFormat } from "../../../../kernel/index.js";
import { boardLinkName } from "../../../../kernel/index.js";
import { discloseBoardState } from "../../../../kernel/index.js";
export { discloseBoardState } from "../../../../kernel/index.js";
export { resolveBoardReference } from "../../../../kernel/index.js";
export { boardItemReference } from "../../../../kernel/index.js";

const PREFIX = 'board_link:';
const VERIFIED_LINKS = new WeakSet();

/** Require a genuine authority operation instead of trusting document-supplied keys or flags. */
function authorityMethod(authority, method) {
  if (typeof authority?.[method] !== 'function') throw new Refused('BOARD_LINK_AUTH', 'configure the trusted signer authority for each endpoint board');
  return authority[method].bind(authority);
}

/** Add one real endpoint approval without mutating the caller's document or spec files. */
export async function approveBoardLink(value, boardId, authority, options) {
  const record = boardLinkRecord(value);
  if (record.revocation || record.approvals.some(row => row.boardId === boardId)) {
    throw new Refused('BOARD_LINK_CONFLICT', 'approve each side once; use a new generation after a revocation');
  }
  const text = boardLinkSigningText(record, boardId, 'approve');
  const approval = await authorityMethod(authority, 'sign')(boardId, text, options);
  if (approval?.boardId !== boardId) throw new Refused('BOARD_LINK_AUTH', 'the signer authority must return this exact board’s approval');
  return boardLinkRecord({ ...record, approvals: [...record.approvals, approval] });
}

/** Authenticate both sides over exactly the same body, and any later one-sided revocation. */
export async function verifyBoardLink(value, authority) {
  const record = boardLinkRecord(value);
  if (record.approvals.length !== 2) throw new Refused('BOARD_LINK_AUTH', 'obtain independent approvals from both endpoint boards');
  const verify = authorityMethod(authority, 'verify');
  for (const approval of record.approvals) {
    if (await verify(approval.boardId, boardLinkSigningText(record, approval.boardId, 'approve'), approval) !== true) {
      throw new Refused('BOARD_LINK_AUTH', 'obtain a verified approval from each endpoint board');
    }
  }
  if (record.revocation && await verify(record.revocation.boardId,
    boardLinkSigningText(record, record.revocation.boardId, 'revoke'), record.revocation) !== true) {
    throw new Refused('BOARD_LINK_AUTH', 'obtain the revoking endpoint’s verified signature');
  }
  Object.freeze(record.parent); Object.freeze(record.child);
  for (const approval of record.approvals) Object.freeze(approval);
  Object.freeze(record.approvals);
  if (record.revocation) Object.freeze(record.revocation);
  Object.freeze(record);
  VERIFIED_LINKS.add(record);
  return record;
}

/** Either board can revoke existing consent without obtaining another signature from its peer. */
export async function revokeBoardLink(value, boardId, authority, options) {
  const record = await verifyBoardLink(value, authority);
  if (record.revocation) return record;
  const text = boardLinkSigningText(record, boardId, 'revoke');
  const revocation = await authorityMethod(authority, 'sign')(boardId, text, options);
  if (revocation?.boardId !== boardId) throw new Refused('BOARD_LINK_AUTH', 'the revoking authority must name its exact board');
  return boardLinkRecord({ ...record, revocation });
}

/** Read a detached catalog of signed records; local paths and project registration add no authority. */
export function readBoardLinks(board) {
  return board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key>=? AND meta_key<? ORDER BY meta_key')
    .all(PREFIX, 'board_link;').map(row => {
      let document;
      try { document = JSON.parse(row.meta_value); } catch { boardLinkFormat('A stored link record is not JSON'); }
      return boardLinkRecord(document);
    });
}

/** Refuse a directed cycle while retaining multiple independent parents. */
function assertAcyclic(records) {
  const children = new Map();
  for (const record of records.filter(row => !row.revocation)) {
    const parent = record.parent.boardId;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(record.child.boardId);
  }
  const active = new Set();
  const visited = new Set();
  /** Visit each reachable endpoint once, rejecting an edge into the current ancestry. */
  function visit(id) {
    if (active.has(id)) throw new Refused('BOARD_LINK_CYCLE', 'remove the cycle before approving this parent link');
    if (visited.has(id)) return;
    active.add(id);
    for (const child of children.get(id) ?? []) visit(child);
    active.delete(id); visited.add(id);
  }
  for (const id of children.keys()) visit(id);
}

/**
 * Persist a verified graph transition atomically. Signatures are checked before taking a board write
 * lock; generation, replay and cycle checks then use the catalog under that actual lock.
 */
export async function applyBoardLink(board, value, authority) {
  return commitVerifiedBoardLink(board, await verifyBoardLink(value, authority));
}

/** Commit only an immutable object verified in this process, after a caller's final authentication await. */
export function commitVerifiedBoardLink(board, record) {
  if (!VERIFIED_LINKS.has(record)) throw new Refused('BOARD_LINK_AUTH', 'verify both board signatures before committing this link');
  return atomic(board, () => {
    const records = readBoardLinks(board);
    const previous = records.find(row => row.linkId === record.linkId);
    if (previous) {
      if (previous.parent.boardId !== record.parent.boardId || previous.child.boardId !== record.child.boardId
        || record.generation < previous.generation
        || record.generation === previous.generation && JSON.stringify(boardLinkBody(previous)) !== JSON.stringify(boardLinkBody(record))) {
        throw new Refused('BOARD_LINK_CONFLICT', 'retain the link identity and use a newer generation with fresh bilateral consent');
      }
      if (record.generation === previous.generation) {
        if (previous.revocation && !record.revocation) throw new Refused('BOARD_LINK_CONFLICT', 'old consent cannot undo a signed revocation; approve a new generation');
        if (previous.revocation || !record.revocation) return previous;
      }
    }
    assertAcyclic([...records.filter(row => row.linkId !== record.linkId), record]);
    board.db.prepare('INSERT INTO board_meta(meta_key,meta_value) VALUES (?,?) ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value')
      .run(PREFIX + record.linkId, JSON.stringify(record));
    const by = (record.revocation ?? record.approvals.at(-1)).by;
    logEvent(board, by, 'board_link', null, { record });
    return record;
  });
}

/** Resolve current structural identity; this lookup alone is never signer authorization. */
function currentBoardLink(board, { linkId, sourceBoardId, destinationBoardId, generation }) {
  const record = readBoardLinks(board).find(row => row.linkId === boardLinkName(linkId));
  if (!record || record.revocation || record.generation !== generation
    || ![record.parent.boardId, record.child.boardId].includes(sourceBoardId)
    || ![record.parent.boardId, record.child.boardId].includes(destinationBoardId) || sourceBoardId === destinationBoardId) {
    throw new Refused('BOARD_LINK_INACTIVE', 'use the current non-revoked bilateral link generation for these exact boards');
  }
  return record;
}

/** Authenticate current consent at an operation boundary, including records restored from storage. */
export async function authorizeBoardLink(board, context, authority) {
  const record = currentBoardLink(board, context);
  const verified = await verifyBoardLink(record, authority);
  // An asynchronous authority can outlive a concurrent revoke or generation transition.
  const current = currentBoardLink(board, context);
  if (JSON.stringify(current) !== JSON.stringify(record)) {
    throw new Refused('BOARD_LINK_CONFLICT', 'refresh the link after its consent changed during authorization');
  }
  return verified;
}

/** Serialize current upstream disclosure; callers still authorize before delivery or any side effect. */
export function boardStateAnnouncement(board, context) {
  if (!context || !Number.isSafeInteger(context.position) || context.position < 0) boardLinkFormat('Use a nonnegative source position');
  const record = currentBoardLink(board, context);
  if (context.sourceBoardId !== record.child.boardId || context.destinationBoardId !== record.parent.boardId) {
    throw new Refused('BOARD_LINK_DISCLOSURE', 'send the child’s disclosed state upstream to its consenting parent');
  }
  if (!Array.isArray(context.rows) || context.rows.some(row => row?.board !== context.sourceBoardId)) {
    throw new Refused('BOARD_LINK_DISCLOSURE', 'announce only items belonging to the authenticated source board');
  }
  return { version: 1, linkId: record.linkId, generation: record.generation,
    sourceBoardId: context.sourceBoardId, destinationBoardId: context.destinationBoardId,
    position: context.position, disclosure: record.disclosure, rows: discloseBoardState(record.disclosure, context.rows) };
}
