/** The pullboard link command: one signed states link between this board and a child board on this machine [E32,B24]. */
import { join } from 'node:path';
import { Refused } from '../../../../../packages/kernel/index.js';
import { listProjects } from '../../../../../packages/seats/index.js';
import { tryGit } from '../../../../../packages/git/index.js';
import {
  applyBoardLink,
  approveBoardLink,
  boardFilePath,
  boardId,
  closeBoard,
  createSshBoardLinkAuthority,
} from '../../../../../packages/store/index.js';
import { context } from '../entry.js';

/**
 * Sign and apply one states link on both boards, the first being the parent.
 * Why both approve here: a link counts only when each board's own signer approves the exact same record, so a missing signer refuses BOARD_LINK_AUTH before any board is written.
 *
 * @param {{ board: any, root: string, reference: object, signer?: { by?: string, key?: string } }} parent
 * @param {{ board: any, root: string, reference: object, signer?: { by?: string, key?: string } }} child
 */
export async function linkBoards(parent, child) {
  const authority = createSshBoardLinkAuthority([parent, child]);
  let record = { version: 1, linkId: `${parent.reference.handle}-${child.reference.handle}`, parent: parent.reference,
    child: child.reference, generation: 1, disclosure: 'states', approvals: [], revocation: null };
  for (const side of [parent, child]) {
    record = await approveBoardLink(record, side.reference.boardId, authority, side.signer);
  }
  await applyBoardLink(parent.board, record, authority);
  await applyBoardLink(child.board, record, authority);
  return record;
}

/** The git email of one checkout, the principal its signer file lists by default. */
function principalOf(root) {
  const email = tryGit(root, ['config', 'user.email'])?.trim();
  if (!email) throw new Refused('BAD_SIGNER', `set git user.email in ${root} so its signer can be named`, 'git config user.email <you>');
  return email;
}

/** Name one board the way the link records it: its immutable id, a local organization and the registry name. */
function referenceOf(board, handle) {
  return { boardId: boardId(board), organization: 'local', handle };
}

/**
 * Run `pullboard link <child> [--by <principal>] [--key <file>]` and return its exit code.
 * <child> is the registry name of another board on this machine; --by and --key name this board's signer, and the child signs with its own default key.
 */
export async function run(io, { first, second, rest, values }) {
  if (!first || second || rest.length || Object.keys(values).some(key => !['json', 'by', 'key'].includes(key))) {
    throw new Refused('USAGE', 'link takes one child board name', 'pullboard link <child> [--by <principal>] [--key <file>]');
  }
  const ctx = context(io);
  const found = listProjects().find(project => project.name === first && project.root !== ctx.info.root);
  if (!found) throw new Refused('LINK_CHILD_UNKNOWN', `no other board named ${first} is registered on this machine`, 'pullboard projects');
  const open = (root) => ctx.nativeBoard.openBoard(boardFilePath(join(root, '.git')), ctx.clock, { isMain: false, gitRoot: root });
  const own = open(ctx.info.root);
  let other = null;
  try {
    other = open(found.root);
    const parent = { board: own, root: ctx.info.root, reference: referenceOf(own, ctx.info.name ?? 'board'),
      signer: { by: values.by ?? principalOf(ctx.info.root), key: values.key } };
    const child = { board: other, root: found.root, reference: referenceOf(other, found.name),
      signer: { by: principalOf(found.root) } };
    const record = await linkBoards(parent, child);
    io.result?.({ link: record.linkId, parent: record.parent, child: record.child, disclosure: record.disclosure });
    io.say(`linked ${record.linkId}: ${record.parent.handle} is the parent of ${record.child.handle}, states only`);
    return 0;
  } finally {
    if (other) closeBoard(other);
    closeBoard(own);
  }
}
