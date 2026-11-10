/** Authorized device-local team and private BoardRefs for cross-board commands [E14,E15,H16]. */
import * as store from "../board.js";
import { listProjects } from "../../../../seats/index.js";
import { withPrivateBoard } from "../../../../seats/index.js";
import { Refused } from "../../../../kernel/index.js";
import { boardReference } from "../../../../kernel/index.js";

/** Read a private board's exact durable reference without creating storage or inferring its owner. */
async function privateReference(project, { openBoard }) {
  if (!project.boardId) return null;
  try {
    return await withPrivateBoard(project.boardId, board => {
      const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key=?').get('private_board_reference');
      if (!row) return null;
      const value = JSON.parse(row.meta_value);
      if (value.version !== 1 || value.kind !== 'private' || value.repoBoardId !== project.boardId
          || typeof value.owner !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(value.owner)
          || typeof value.organization !== 'string' || typeof value.handle !== 'string') return null;
      return { ...boardReference({ boardId: store.boardId(board), organization: value.organization, handle: value.handle }),
        kind: 'private', root: project.root, repoBoardId: project.boardId };
    }, { create: false, store: { ...store, openBoard } });
  } catch { return null; }
}

/** Load only registry-recorded identities and existing private files through the caller's native opener. */
export async function localBoardInventory({ openBoard }) {
  const projects = listProjects();
  const rows = new Map();
  for (const project of projects) {
    if (project.boardId && project.owner && project.handle) {
      try {
        const reference = boardReference({ boardId: project.boardId, organization: project.owner, handle: project.handle });
        rows.set(`${reference.boardId}:team`, { ...reference, kind: 'team', root: project.root });
      } catch { /* An invalid local record cannot authorize a board reference. */ }
    }
    const privateBoard = await privateReference(project, { openBoard });
    if (privateBoard) rows.set(`${privateBoard.boardId}:private`, privateBoard);
  }
  return [...rows.values()];
}

/** Resolve an item handle or destination handle only from the caller's authorized local inventory. */
export function resolveLocalBoard(inventory, requested, { kind = 'team' } = {}) {
  if (!Array.isArray(inventory) || typeof requested !== 'string' || requested.length > 260) {
    throw new Refused('BOARD_REFERENCE', 'use one exact local board handle');
  }
  let privateBoard = kind === 'private';
  let name = requested;
  if (name.startsWith('~')) { privateBoard = true; name = name.slice(1); }
  const choices = inventory.filter(row => row.kind === (privateBoard ? 'private' : 'team'));
  const matches = name.includes('/')
    ? choices.filter(row => `${row.organization}/${row.handle}` === name)
    : choices.filter(row => row.handle === name);
  if (matches.length !== 1) {
    const listed = [...new Set(matches.map(row => `${privateBoard ? '~' : ''}${row.organization}/${row.handle}`))].sort();
    const detail = matches.length > 1 ? `; choose ${listed.join(', ')}` : '';
    throw new Refused('BOARD_REFERENCE', `use one exact authorized ${privateBoard ? 'private ' : ''}board handle${detail}`);
  }
  return { ...matches[0] };
}

/** Resolve `handle#id`, `owner/handle#id`, private `~handle#id`, or the current-board numeric ID. */
export function resolveLocalItemReference(inventory, reference, currentBoardId) {
  const text = String(reference ?? '');
  if (/^[1-9][0-9]*$/u.test(text)) {
    const itemId = Number(text);
    if (!Number.isSafeInteger(itemId)) throw new Refused('BAD_ITEM_ID', 'use one safe positive item number');
    return { boardId: currentBoardId, itemId };
  }
  const split = text.lastIndexOf('#');
  const name = split > 0 ? text.slice(0, split) : '';
  const itemId = split > 0 ? Number(text.slice(split + 1)) : NaN;
  if (!Number.isSafeInteger(itemId) || itemId < 1) throw new Refused('BAD_ITEM_ID', 'use handle#id, owner/handle#id, ~handle#id, or one current-board item number');
  const board = resolveLocalBoard(inventory, name);
  return { boardId: board.boardId, itemId };
}
