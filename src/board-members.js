/** Signed membership travels inside the native sealed board state [E17,H16]. */
import { Refused } from './refused.js';
import { COORDINATOR } from './config.js';
import {
  atomic,
  logEvent,
} from './board-event-log.js';
import { ENGINE_VERSION } from './machine.js';
import { BOARD_MEMBERS_ENGINE } from './board-members-engine.js';

const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u;

/** Copy only the complete, exact signed format; unknown fields cannot acquire unsigned meaning. */
export function boardMembersDocument(value) {
  const exact = (object, keys) => object && typeof object === 'object' && !Array.isArray(object) &&
    Object.keys(object).sort().join(',') === [...keys].sort().join(',');
  const body = value?.body;
  if (!exact(value, ['body', 'by', 'signature']) || !exact(body, ['v', 'board', 'repository', 'revision', 'members']) ||
      body.v !== 1 || typeof body.board !== 'string' || !/^[a-f0-9]{32}$/u.test(body.board) ||
      typeof body.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(body.repository) ||
      !Number.isSafeInteger(body.revision) || body.revision < 1 || !Array.isArray(body.members) || body.members.length > 100 ||
      body.members.some(login => typeof login !== 'string' || !LOGIN.test(login)) ||
      new Set(body.members.map(login => login.toLowerCase())).size !== body.members.length ||
      typeof value.by !== 'string' || !LOGIN.test(value.by) || typeof value.signature !== 'string' ||
      !value.signature.startsWith('-----BEGIN SSH SIGNATURE-----') || value.signature.length > 16384) {
    throw new Refused('BOARD_MEMBERS_INVALID', 'the board member list is not a complete signed v1 document; ask a committed approver to publish a new list');
  }
  return { body: { v: 1, board: body.board, repository: body.repository, revision: body.revision, members: [...body.members] },
    by: value.by, signature: value.signature };
}

/** Canonical bytes include every body field and the named signer, separated from device and identity proofs. */
export function boardMembersBytes(document) {
  const { body, by } = document;
  return JSON.stringify(['pullboard-board-members', { v: body.v, board: body.board, repository: body.repository,
    revision: body.revision, members: [...body.members] }, by]);
}

/** Read the current signed document, including an empty revocation list's revision. */
export function readBoardMembers(board) {
  const row = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get('board_members');
  if (!row) return null;
  let value;
  try { value = JSON.parse(row.meta_value); } catch { throw new Refused('BOARD_MEMBERS_INVALID', 'the stored board member list is malformed; ask a committed approver to publish a new list'); }
  return boardMembersDocument(value);
}

/** Store an approver's signed list through its coordinator atomically; authorization is reverified at every key handover, never cached here. */
export function setBoardMembers(board, { agentId, document }) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < BOARD_MEMBERS_ENGINE) throw new Refused('ENGINE_VERSION', 'update pullboard before recording board members');
  if (agentId !== COORDINATOR) throw new Refused('COORDINATOR_ONLY', 'the coordinator records the approver-signed member list; publish it from the main checkout');
  const next = boardMembersDocument(document);
  return atomic(board, () => {
    const id = board.db.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get('board_id')?.meta_value;
    if (next.body.board !== id) throw new Refused('BOARD_MEMBERS_INVALID', 'the signed member list names another board');
    const previous = readBoardMembers(board);
    if (previous && JSON.stringify(previous) === JSON.stringify(next)) return previous;
    if (next.body.revision !== (previous?.body.revision ?? 0) + 1) throw new Refused('BOARD_MEMBERS_REVISION', 'the board member list changed; read its current revision and sign a new list');
    board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?) ON CONFLICT(meta_key) DO UPDATE SET meta_value = excluded.meta_value')
      .run('board_members', JSON.stringify(next));
    logEvent(board, agentId, 'board_members', null, { document: next });
    return next;
  });
}
