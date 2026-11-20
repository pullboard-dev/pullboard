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
