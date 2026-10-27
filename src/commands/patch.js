/** Attach, inspect, or remove an immutable source-bound patch for a submitted item [V4,H16]. */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import * as store from '../board.js';
import { Refused } from '../refused.js';
import { validateItemPatchInput } from '../item-patch-review.js';
import { relayCommandReceipt, relayCommandReceiptReported } from '../relay.js';
import { actOn, idArg, ordered } from '../cli.js';
import { context } from '../cli-read-context.js';
import { withBoardRead } from '../cli-board-read.js';

const MAX_PATCH_BYTES = 8 * 1024 * 1024;

/** Read exact UTF8 patch bytes only after interrupted command recovery has been checked. */
function patchText(root, file) {
  const path = resolve(root, file);
  let stat;
  try { stat = statSync(path); } catch { throw new Refused('ITEM_PATCH_FORMAT', `cannot read patch file "${file}"`); }
  if (!stat.isFile() || stat.size > MAX_PATCH_BYTES) throw new Refused('ITEM_PATCH_FORMAT', 'supply a regular UTF8 patch file of at most eight MiB');
  let bytes;
  try { bytes = readFileSync(path); } catch { throw new Refused('ITEM_PATCH_FORMAT', `cannot read patch file "${file}"`); }
  if (bytes.length > MAX_PATCH_BYTES) throw new Refused('ITEM_PATCH_FORMAT', 'supply a regular UTF8 patch file of at most eight MiB');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Refused('ITEM_PATCH_FORMAT', 'patch file must contain valid UTF8');
  return text;
}

/** Apply an already-recorded receipt to this CLI invocation without rereading its patch file. */
function replay(io, recovered) {
  io.recordedMove = true;
  for (const event of recovered.events) io.onEvent?.(event);
  return recovered.result;
}

/** Run the coordinator-only `patch attach|list|remove` command. */
export async function run(io, { first, second, rest, values }) {
  const subcommand = first;
  if (!['attach', 'list', 'remove'].includes(subcommand)) {
    throw new Refused('USAGE', 'use pullboard patch attach <item> <file> --key <key> --author <seat> [--source <submittedSHA>], patch list <item>, or patch remove <item> <key>');
  }
  const id = idArg(second, 'an item id');
  if (subcommand === 'list') {
    if (rest.length) throw new Refused('USAGE', 'use pullboard patch list <item>');
    const ctx = context(io);
    const result = await withBoardRead(ctx, board => ({ item: id,
      patches: store.itemPatches(board, id), digest: store.itemPatchDigest(board, id) }));
    io.result?.(result);
    if (!result.patches.length) io.say(`no patches attached to #${id}`);
    else {
      io.say(`#${id} patch set ${result.digest}`);
      for (const patch of result.patches) io.say(`${patch.key} ${patch.digest} from ${patch.commit} by ${patch.author.agentId}`);
    }
    return 0;
  }

  return actOn(io, async (ctx, board, me) => {
    const recovered = await relayCommandReceipt(ctx.info.root, io.relayCommand);
    if (recovered) {
      const result = replay(io, recovered);
      io.result?.(result);
      if (subcommand === 'attach') io.say(`${result.changed ? 'attached' : 'unchanged'} patch ${result.key} on #${id} (${result.digest})`);
      else io.say(`${result.changed ? 'removed' : 'unchanged'} patch ${result.key} from #${id} (${result.digest})`);
      await relayCommandReceiptReported(ctx.info.root, recovered.move.id);
      return 0;
    }

    let result;
    if (subcommand === 'attach') {
      if (rest.length !== 1 || !values.key || !values.author) {
        throw new Refused('USAGE', 'use pullboard patch attach <item> <file> --key <key> --author <seat> [--source <submittedSHA>]');
      }
      const item = store.getItem(board, id);
      if (me.id !== 'coordinator') throw new Refused('COORDINATOR_ONLY', 'only the coordinator attaches item patches');
      const patch = patchText(ctx.info.root, rest[0]);
      validateItemPatchInput(board, ctx.config, values.author, patch);
      result = await ordered(ctx, board, 'attachItemPatch', [id, {
        agentId: me.id,
        key: values.key,
        commit: values.source ?? item.item_commit,
        patch,
        author: values.author,
      }]);
      io.result?.(result);
      io.say(`${result.changed ? 'attached' : 'unchanged'} patch ${result.key} on #${id} (${result.digest})`);
    } else {
      if (rest.length !== 1) throw new Refused('USAGE', 'use pullboard patch remove <item> <key>');
      result = await ordered(ctx, board, 'removeItemPatch', [id, { agentId: me.id, key: rest[0] }]);
      io.result?.(result);
      io.say(`${result.changed ? 'removed' : 'unchanged'} patch ${result.key} from #${id} (${result.digest})`);
    }
    return 0;
  });
}
