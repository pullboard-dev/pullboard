/**
 * The signer authority and per-link sealing capability the verify path hands to deliverBoardState [E32,H16,#11157].
 * Why: packages never import apps, so the command side builds these two ports from the boards' roots and the key store
 * and passes them in; a board with no signer file or no key refuses with the step that sets the link up. The caller names
 * how the key is read (the keys cell's readBoardKey), because this file has no declared edge to the keys cell.
 */
import { Refused } from '../../../../../packages/kernel/index.js';
import { createBoardLinkCapability } from '../../../../../packages/store/index.js';
import { createSshBoardLinkAuthority } from '../../../../../packages/store/index.js';
import { boardHasSigner } from '../../../../../packages/store/index.js';
import { createBoardLinkFileTransport } from '../../../../../packages/store/index.js';
import { readBoardLinks } from '../../../../../packages/store/index.js';
import { listItems } from '../../../../../packages/store/index.js';
import { boardId } from '../../../../../packages/store/index.js';
import { join } from 'node:path';

/** The refusal every missing piece of link authority raises, naming the command that sets the link up. */
const unavailable = (why) => new Refused('BOARD_LINK_AUTH', `${why}; next: run pullboard link to sign this board link on both boards`);

/**
 * Build { authority, capability } for one signed link record.
 *
 * @param {{ child: { board: object, root: string }, parent: { board: object, root: string }, record: object, readKey: (boardId: string) => Uint8Array | undefined }} input
 * @returns {{ authority: object, capability: object }}
 */
export function boardLinkPorts({ child, parent, record, readKey }) {
  if (typeof readKey !== 'function') throw unavailable('no way to read the parent board key');
  for (const [name, side] of [['child', child], ['parent', parent]]) {
    if (!side?.board || typeof side.root !== 'string' || !boardHasSigner(side.root)) throw unavailable(`the ${name} board has no signer file`);
  }
  const authority = createSshBoardLinkAuthority([{ board: child.board, root: child.root }, { board: parent.board, root: parent.root }]);
  let key;
  try { key = readKey(record.parent.boardId); }
  catch (error) { if (error instanceof Refused) throw unavailable(`no key for the parent board: ${error.message}`); throw error; }
  if (!(key instanceof Uint8Array)) throw unavailable('no key for the parent board');
  return { authority, capability: createBoardLinkCapability(record, key) };
}

/**
 * The announce ports for every live link whose child is this board: the signed record, the parent's item rows, and a file transport into the parent's folder [E32,B24,#11039].
 * Why: a verdict on a child item must reach each parent that waits on it; a parent with no signer, no key or no registered board is skipped, so a verify never fails for a link that was never set up.
 *
 * @param {{ board: object, root: string }} child
 * @param {{ projects: { name: string, root: string }[], openBoard: (root: string) => object, closeBoard: (board: object) => void, readKey: (boardId: string) => Uint8Array | undefined, portsFor?: typeof boardLinkPorts }} environment
 * @returns {{ links: object[], close: () => void }}
 */
export function announcePorts(child, { projects, openBoard, closeBoard, readKey, portsFor = boardLinkPorts }) {
  const links = [];
  const opened = [];
  const self = boardId(child.board);
  for (const record of readBoardLinks(child.board)) {
    if (record.revocation || record.child.boardId !== self) continue;
    const found = projects.find((project) => project.name === record.parent.handle);
    if (!found) continue;
    let parentBoard;
    try {
      parentBoard = openBoard(found.root);
      opened.push(parentBoard);
      if (boardId(parentBoard) !== record.parent.boardId) continue;
      const parent = { board: parentBoard, root: found.root };
      const { authority, capability } = portsFor({ child, parent, record, readKey });
      links.push({ record, parentItems: listItems(parentBoard, { all: true }), authority, capability,
        transport: createBoardLinkFileTransport(join(found.root, '.git', 'pullboard', 'board-links'), { board: self }) });
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
    }
  }
  return { links, close: () => { for (const board of opened) closeBoard(board); } };
}
