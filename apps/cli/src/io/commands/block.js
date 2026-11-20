/** The pullboard block command: block add records a named block of items, block list prints each as one row, block claim takes every member for this seat [C7,#2202]. */
import { Refused } from '../../../../../packages/kernel/index.js';
import { listBlocks } from '../../../../../packages/store/index.js';
import { actOn } from '../entry.js';
import { claimFreezer } from '../claim.js';
import { openItemFolder } from '../item/folder.js';
import { idArg } from '../entry.js';
import { ordered } from '../entry.js';
import { context } from '../entry.js';
import { withBoardRead } from '../entry.js';

const USAGE = 'pullboard block add <name> <id> <id> [<id> ...] --tier <light|mid|strong>, pullboard block claim <name>, or pullboard block list [--json]';

/** The one printed row of a block: its name, tier and member ids. */
function blockRow(block) {
  return `${block.name} ${block.tier} ${block.members.map(id => `#${id}`).join(' ')}`;
}

/**
 * Run `pullboard block add|claim|list` and return its exit code.
 * Why the add is an ordered move and the list a plain read: the record replays on every replica, while a listing changes nothing [C7,#2202].
 */
export async function run(io, { first, second, rest, values }) {
  if (first === 'list') {
    if (second || rest.length || Object.keys(values).some(key => key !== 'json')) throw new Refused('USAGE', 'block list takes no arguments', USAGE);
    const blocks = withBoardRead(context(io), board => listBlocks(board));
    io.result?.({ blocks });
    if (!blocks.length) io.say('no blocks');
    for (const block of blocks) io.say(blockRow(block));
    return 0;
  }
  if (first === 'claim') {
    if (!second || rest.length || Object.keys(values).some(key => key !== 'json')) throw new Refused('USAGE', 'block claim takes one block name', USAGE);
    return actOn(io, async (ctx, board, me) => {
      // One move claims every open member in one write; a member another seat holds refuses BLOCK_CLAIMED before anything is written [C7,#2202].
      const claimed = await ordered(ctx, board, 'claimBlock', [{ agentId: me.id, name: second, lane: me.lane, leaseMs: ctx.config.leaseMs, itemFolder: true, freeze: claimFreezer(ctx, board) }]);
      const result = claimed ?? listBlocks(board).find(entry => entry.name === second);
      const ids = result.claimed ?? result.members ?? [];
      const folders = {};
      for (const id of ids) {
        try {
          folders[id] = await openItemFolder(ctx, me, id, { board, renewed: false, onConflict: (files, line) => io.say(`warning: ${line}`) });
        } catch (error) {
          // The claims are already recorded, so a folder refusal is reported beside them, never as the command's refusal (#5766).
          if (!(error instanceof Refused)) throw error;
          io.say(`warning: item folder for #${id} not opened: [${error.code}] ${error.message}; the claim is recorded`);
        }
      }
      io.result?.({ name: second, claimed: ids, ...(result.leaseUntil ? { leaseUntil: result.leaseUntil } : {}), itemFolders: folders });
      io.say(`claimed block ${second}: ${ids.map(id => `#${id}`).join(' ')}${result.leaseUntil ? ` until ${result.leaseUntil}` : ''}`);
      for (const id of ids) if (folders[id]) io.say(`item folder #${id}: ${folders[id]}`);
      return 0;
    });
  }
  if (first !== 'add' || !second || Object.keys(values).some(key => key !== 'tier' && key !== 'json')) throw new Refused('USAGE', 'block takes add, claim or list', USAGE);
  // The tier is checked with the ids in newBlock, so a wrong tier or one id is refused USAGE before any board write.
  const ids = rest.map(idArg);
  return actOn(io, async (ctx, board, me) => {
    const block = await ordered(ctx, board, 'addBlock', [{ agentId: me.id, name: second, ids, tier: values.tier }]);
    const recorded = block ?? listBlocks(board).find(entry => entry.name === second);
    io.result?.({ block: recorded });
    io.say(blockRow(recorded));
    return 0;
  });
}
