import { asSubmitted } from '../../../../../packages/verify/index.js';
import { refuseUnreviewable } from '../../../../../packages/verify/index.js';
import { normalizeItemPatch } from '../../../../../packages/items/index.js';
import { itemPatchParts } from '../../../../../packages/items/index.js';
import { laneOf } from '../../../../../packages/seats/index.js';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { itemPolicy } from '../../../../../packages/sandbox/index.js';
import { headCommit } from '../../../../../packages/git/index.js';
import { claimedItemRoot } from '../item/folder/identity.js';
/** Attach, inspect, or remove an immutable source-bound patch for a submitted item [V4,H16]. */
import { readFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import * as store from '../../../../../packages/store/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { refuseLiveAttach } from '../../../../../packages/items/index.js';
import { validateItemPatchInput } from '../../../../../packages/items/index.js';
import { relayCommandReceipt } from '../../../../../packages/link/index.js';
import { relayCommandReceiptReported } from '../../../../../packages/link/index.js';
import { actOn } from '../entry.js';
import { idArg } from '../entry.js';
import { ordered } from '../entry.js';
import { context } from '../read.js';
import { withBoardRead } from '../board/read.js';

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

/** Describe actual owning lanes and registered owner seats without attaching or confirming their work. */
function splitPatch(board, config, patch) {
  const groups = new Map();
  for (const part of itemPatchParts(patch)) {
    const lane = laneOf(config, part.paths[0]);
    const group = groups.get(lane) ?? { lane, paths: [], patch: '' };
    group.paths.push(...part.paths); group.patch += part.patch;
    groups.set(lane, group);
  }
  const seats = board.db.prepare('SELECT agent_id, agent_lane FROM agent ORDER BY agent_id').all();
  return [...groups.values()].map(part => ({ ...part,
    owners: part.lane === 'coordinator' ? ['coordinator'] : seats.filter(seat => seat.agent_lane === part.lane).map(seat => seat.agent_id),
  }));
}

/** Write explicit draft outputs exclusively; existing owner files are never overwritten. */
function writeParts(root, directory, parts) {
  const target = resolve(root, directory);
  const files = parts.map(part => {
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(part.lane)) throw new Refused('ITEM_PATCH_FORMAT', 'owning lane cannot name a portable split output');
    return join(target, part.lane + '.patch');
  });
  if (files.some(file => existsSync(file))) throw new Refused('ITEM_PATCH_OUTPUT', 'a split output already exists; choose a fresh --out directory');
  mkdirSync(target, { recursive: true });
  for (const [n, file] of files.entries()) writeFileSync(file, parts[n].patch, { flag: 'wx' });
  return parts.map((part, n) => ({ ...part, file: files[n] }));
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
  if (!['attach', 'list', 'remove', 'object'].includes(subcommand)) {
    throw new Refused('USAGE', 'use pullboard patch attach <item> <file> --key <key> --author <seat> [--source <submittedSHA>], patch list <item>, patch remove <item> <key>, or patch object <item> <key> --note "why"');
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

  if (subcommand === 'object') {
    if (rest.length !== 1 || !values.note) throw new Refused('USAGE', 'use pullboard patch object <item> <key> --note "why"');
    return actOn(io, async (ctx, board, me) => {
      const result = await ordered(ctx, board, 'objectItemPatch', [id, { agentId: me.id, key: rest[0], note: values.note }]);
      io.result?.(result);
      io.say(`reopened #${id}; ${me.id} objected to companion ${rest[0]}`);
      return 0;
    });
  }

  return actOn(io, async (ctx, board, me) => {
    const recovered = await relayCommandReceipt(ctx.info.root, io.relayCommand, io);
    if (recovered) {
      const result = replay(io, recovered);
      io.result?.(result);
      if (subcommand === 'attach') io.say(`${result.changed ? 'attached' : 'unchanged'} patch ${result.key} on #${id} (${result.digest})`);
      else io.say(`${result.changed ? 'removed' : 'unchanged'} patch ${result.key} from #${id} (${result.digest})`);
      await relayCommandReceiptReported(ctx.info.root, recovered.move.id, io);
      return 0;
    }

    let result;
    if (subcommand === 'attach') {
      if (rest.length !== 1 || !values.key || !values.author) {
        throw new Refused('USAGE', 'use pullboard patch attach <item> <file> --key <key> --author <seat> [--source <submittedSHA>]');
      }
      const item = store.getItem(board, id);
      if (me.id !== 'coordinator') throw new Refused('COORDINATOR_ONLY', 'only the coordinator attaches item patches');
      const patch = normalizeItemPatch(patchText(ctx.info.root, rest[0]));
      const policy = itemPolicy(ctx.info.root, item);
      let parts = splitPatch(board, policy.config, patch);
      if (parts.length > 1) {
        if (values.out) parts = writeParts(ctx.info.root, values.out, parts);
        io.result?.({ item: id, attached: false, needsConfirmation: true, parts });
        for (const part of parts) io.say(`${part.lane}: ${part.paths.join(', ')}; owner seats: ${part.owners.join(', ') || 'none registered'}${part.file ? '; draft: ' + part.file : ''}`);
        io.say('No patch attached. Each owning seat must confirm its part; attach each confirmed part separately with its registered --author. Use --out <directory> to write per-lane drafts.');
        return 0;
      }
      validateItemPatchInput(board, policy.config, values.author, patch, policy.commit);
      const builderPath = item.item_status === 'claimed' ? claimedItemRoot(board, item) : null;
      const builderHead = builderPath ? headCommit(builderPath) : null;
      const source = values.source ?? (item.item_status === 'claimed' ? builderHead : item.item_commit);
      if (item.item_status === 'claimed' && (!source || builderHead && builderHead !== source)) {
        throw new Refused('ITEM_PATCH_SOURCE', 'attach against the current builder head; name --source when its checkout is unavailable');
      }
      refuseLiveAttach(board, item, { key: values.key, author: values.author, commit: source, patch }, { asSubmitted, refuseUnreviewable, atomic: store.atomic, listAgents: store.listAgents, review: { policy: ctx.config.verify.policy, familyPolicy: ctx.config.verify.family } });
      result = await ordered(ctx, board, 'attachItemPatch', [id, {
        agentId: me.id,
        key: values.key,
        commit: source,
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
