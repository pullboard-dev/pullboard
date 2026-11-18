/**
 * One item's detail read, shared by the request thread and the pool worker that serves GET /boards/:id/items/:itemId [A2,C7].
 * Why a module of its own: main.js is over its size cap and takes no added lines, and a pool worker cannot be handed this
 * closure, so each thread composes its own reader, with its own caches, from the same code.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCommit } from '../../../git/index.js';
import { trunkRevisionReader } from '../../../git/index.js';
import { stateFileInputs } from '../../../store/index.js';
import * as store from '../../../store/index.js';
import { itemDetail } from './items.js';

/** How many item details a server keeps for each board: past a board our size, the least recently read go first. */
const DETAIL_CACHE_ITEMS = 4096;

/** Cheap file identity for an event-stream poll; content is read only after this marker changes. */
export function fileMarker(file) {
  try {
    const stat = statSync(file.path);
    return [file.name, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [file.name, null];
    throw error;
  }
}

/** Capture a marker for a single absolute path, including an explicit missing-file value. */
export function fileMarkerForPath(path) {
  try {
    const stat = statSync(path);
    return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return 'missing';
    throw error;
  }
}

/**
 * The item detail reader of one thread: its detail and spec-approval caches (#1040) and the read itself.
 *
 * @param {{ withReadBoard: Function, projectItemState: Function, isMain?: boolean, boardOpeners: any, onItemBuild?: Function, cells: Record<string, any> }} ports
 * withReadBoard(root, read, isMain, boardOpeners) opens the read-only board connection; projectItemState is the API's item projection;
 * cells are the functions of the sibling cells it reads, given by main.js, which already imports them (a new file's own cell imports raise the ratchet).
 * @returns {(board: { root: string, id: string }, id: number) => any} The item's detail, or null when the board has no such item.
 */
export function itemDetailReader({ withReadBoard, projectItemState, isMain, boardOpeners, onItemBuild, cells }) {
  const { fitFile, loadConfig, localDependencyIds, SUMMARY_KEYS, verifiedPasskeyRowDecision, projectItemSpecApprovals, specApprovalState, verdictProjector, typedFieldsEnabled, hunkFreshnessEnabled } = cells;
  // Each board's item details by item id, and each board's spec-approval view (#1040).
  const detailCache = new Map();
  const approvalCache = new Map();
  /**
   * The spec-approval view one board's details share, kept while the files, HEAD and board records it
   * reads hold: it reads every row decision and sign-off, so building it per detail cost most of one.
   */
  function approvalFor(root, currentBoard, info) {
    const config = loadConfig(root);
    const meta = currentBoard.db.prepare("SELECT meta_key, meta_value FROM board_meta WHERE meta_key IN ('row_decisions', 'spec_approval_baseline') ORDER BY meta_key").all();
    const key = JSON.stringify([stateFileInputs(info.root, config, { fitFile }).map(fileMarker), fileMarkerForPath(join(info.root, '.mailmap')), resolveCommit(info.root, 'HEAD'), meta]);
    const cacheId = JSON.stringify([info.commonDir, root]);
    const cached = approvalCache.get(cacheId);
    if (cached?.key === key) return cached.approval;
    const approval = specApprovalState(root, { board: currentBoard, config }, { store, verifiedPasskeyRowDecision });
    approvalCache.delete(cacheId);
    approvalCache.set(cacheId, { key, approval });
    while (approvalCache.size > 32) approvalCache.delete(approvalCache.keys().next().value);
    return approval;
  }
  /**
   * One item's detail, or null when the board has no such item. It reads only that item's rows by
   * index, and its detail is kept by the item's last event id with the few facts beyond its own
   * events that a detail shows: its row and live leases, its prerequisites' statuses, the trunk and
   * the spec-approval inputs (#1040).
   */
  function localItem(board, id) {
    return withReadBoard(board.root, (currentBoard, info) => {
      currentBoard.db.exec('BEGIN');
      try {
        const detail = itemDetailIn(board, currentBoard, info, id);
        currentBoard.db.exec('COMMIT');
        return detail;
      } catch (error) {
        try { currentBoard.db.exec('ROLLBACK'); } catch { /* Preserve the projection failure. */ }
        throw error;
      }
    }, isMain, boardOpeners);
  }
  /** Serve an item's cached detail while its key holds, building and keeping it when the key moved. */
  function itemDetailIn(board, currentBoard, info, id) {
    const { db } = currentBoard;
    const row = db.prepare('SELECT * FROM item WHERE item_id = ?').get(id);
    if (!row) return null;
    // Typed fields and free links are written without an event, so the detail key carries them; with items.typedFields off both stay out and the key is what it was (#9835) [C7].
    const typed = typedFieldsEnabled?.() === true, fields = typed ? store.itemFields(currentBoard, id, { enabled: true }) : [];
    const links = typed ? store.relatedLinks(currentBoard, id, { enabled: true }).map(other => ({ id: other, title: db.prepare('SELECT item_title FROM item WHERE item_id=?').get(other)?.item_title ?? '' })) : [];
    const now = currentBoard.clock.now().toISOString();
    const status = new Map();
    for (const dependency of localDependencyIds(row)) {
      const dependent = db.prepare('SELECT item_status FROM item WHERE item_id = ?').get(dependency);
      if (dependent) status.set(dependency, dependent.item_status);
    }
    for (const ref of store.foreignDependencyStates(currentBoard, row)) status.set(`${ref.repo}#${ref.id}`, ref.status);
    // Detail reads need no new Git process while the trunk holds.
    const tip = trunkRevisionReader(info)();
    const approval = approvalFor(board.root, currentBoard, info);
    const key = JSON.stringify([row, row.item_status === 'claimed' && (row.item_lease_until ?? '') > now,
      row.item_status === 'submitted' && Boolean(row.item_review_by) && (row.item_review_until ?? '') > now,
      db.prepare('SELECT MAX(event_id) AS id FROM event WHERE item_id = ?').get(id).id,
      db.prepare('SELECT MAX(verdict_id) AS id FROM verdict WHERE item_id = ?').get(id).id,
      [...status], db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get(`item_check_baseline_${id}`)?.meta_value ?? null, tip, typed ? [fields, links] : null]);
    const cacheId = JSON.stringify([info.commonDir, board.id]);
    let details = detailCache.get(cacheId);
    const cached = details?.get(id);
    if (cached?.key === key && cached.approval === approval) return cached.detail;
    const source = store.getItem(currentBoard, id);
    const base = projectItemSpecApprovals(projectItemState(currentBoard, source, status), approval);
    // The projector owns this transaction's connection; only derived values cross requests.
    const verdictState = verdictProjector(board.root, currentBoard, { main: tip }, { events: store.events, acceptedVerdict: store.acceptedVerdict, verdictReviewProblem: store.verdictReviewProblem, hunkKeyed: hunkFreshnessEnabled?.() === true }).state(source);
    const projected = {
      ...base,
      ...(verdictState ? { verdictState } : {}),
      check: source.item_check,
      ...(source.item_check_baseline ? { checkBaseline: source.item_check_baseline } : {}),
      thread: store.itemThread(currentBoard, id),
      ...(typed ? { fields, links } : {}),
    };
    onItemBuild?.({ board: board.id, itemId: id });
    const detail = itemDetail(projected, SUMMARY_KEYS);
    // Missing Git objects can arrive with no event or trunk move, so an uncertain verdict is read again.
    if (!verdictState?.reason) {
      if (!details) {
        details = new Map();
        detailCache.set(cacheId, details);
        while (detailCache.size > 32) detailCache.delete(detailCache.keys().next().value);
      }
      details.delete(id);
      details.set(id, { key, approval, detail });
      while (details.size > DETAIL_CACHE_ITEMS) details.delete(details.keys().next().value);
    }
    return detail;
  }
  return localItem;
}
