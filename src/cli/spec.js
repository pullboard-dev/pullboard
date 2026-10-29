/** Helpers for `pullboard spec`: row reservations, citations and current proof. Split from src/cli.js, which re-exports it [C7]. */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import * as store from '../board.js';
import { hookRead } from '../cli-support.js';
import { withBoard } from '../cli-context.js';
import { git } from '../git.js';
import { gitChildEnv } from '../git.js';
import { mainCheckout } from '../git.js';
import { Refused } from '../refused.js';
import { commitCitations } from '../history.js';
import { committedIds } from '../history.js';
import { trunkRef } from '../trusted-policy.js';
import { ordered } from './claim.js';
import { whoAmI } from './join.js';

/**
 * Read the collision baseline from the primary branch, retained trunk, or detached HEAD default.
 *
 * @param {string} root
 * @param {string} path
 * @param {string} [revision]
 * @returns {{ status: number, stdout: string, baseline?: string }}
 */
export function coordinatorFile(root, path, revision) {
  const commonDir = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const coordinatorRoot = dirname(commonDir);
  const env = { ...gitChildEnv(root), GIT_NO_REPLACE_OBJECTS: '1' };
  const primary = mainCheckout(coordinatorRoot);
  let ref = primary?.branch ?? trunkRef(coordinatorRoot);
  const detachedHeadDefault = !primary && !ref;
  if (detachedHeadDefault) ref = 'HEAD';
  if (ref !== 'HEAD' && !ref?.startsWith('refs/heads/')) {
    throw new Refused('NO_TRUNK', 'no trunk branch was recorded; check out the trunk branch in the main checkout once and run pullboard inbox');
  }
  if (!primary) {
    const tip = spawnSync('git', ['--no-replace-objects', 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd: coordinatorRoot, env, encoding: 'utf8',
    });
    if (tip.status !== 0) {
      throw new Refused('NO_TRUNK', 'the recorded trunk branch has no readable tip; check out the trunk branch in the main checkout once and run pullboard inbox');
    }
    ref = tip.stdout.trim();
  }
  const result = spawnSync('git', ['--no-replace-objects', 'show', `${revision ?? ref}:${path}`], {
    cwd: coordinatorRoot, env, encoding: 'utf8',
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    ...(detachedHeadDefault ? { baseline: 'collision baseline default: detached HEAD' } : {}),
  };
}
/**
 * Reserve a new row's id on the board in one write transaction before any file names it, so writers
 * that plan the same id at the same moment get distinct ids (#878). written: the caller writes the row
 * into its own file now; otherwise it is a lane draft that spec apply writes. With no board yet there is
 * no other writer, and the planned id stands.
 */
export async function reserveRow(ctx, row, written) {
  if (!existsSync(ctx.file)) return row;
  return withBoard(ctx, async (board) => ordered(ctx, board, 'draftSpecRow', [{ agentId: store.agentAt(board, ctx.info.root)?.agent_id ?? whoAmI(ctx, board).id, row, written }]));
}

/**
 * Every spec id something cites (S8): commit headers since the spec's first commit, and every item
 * on the board, open or closed. The connection is read-only: spec lint never migrates a shared board. Each must still be in the spec. The board is shared by every
 * checkout, so at an older commit an item may cite a row a later commit added: that id is not lost
 * here, only not written yet, and it counts once any ref has committed it (S10).
 *
 * @param {any} ctx
 * @param {{ ids: Map<string, string>, since: string | null }} history - this checkout's.
 * @returns {Map<string, string>} Each id, with who cites it.
 */
export function citations(ctx, { ids, since }) {
  const cited = since ? commitCitations(ctx.info.root, since) : new Map();
  if (!existsSync(ctx.file)) return cited;
  const byItems = new Map();
  for (const item of hookRead(ctx, (board) => store.listItems(board, { all: true }))) {
    for (const id of item.item_spec_ids ? item.item_spec_ids.split(',') : []) {
      if (!cited.has(id) && !byItems.has(id)) byItems.set(id, `item #${item.item_id}`);
    }
  }
  const unseen = [...byItems.keys()].some((id) => !ids.has(id));
  const elsewhere = unseen ? committedIds(ctx.info.root, ctx.config.spec, ['--all']).ids : new Map();
  for (const [id, where] of byItems) if (ids.has(id) || !elsewhere.has(id)) cited.set(id, where);
  return cited;
}

/** Current board evidence, with each item's accepting receipts included once. */
export function specProof(ctx) {
  if (!existsSync(ctx.file)) return { items: [], verdicts: [] };
  return withBoard(ctx, (board) => {
    const items = store.listItems(board, { all: true });
    return { items, verdicts: items.flatMap((item) => store.verdictsFor(board, item.item_id)) };
  });
}

