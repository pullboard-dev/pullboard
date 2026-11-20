import { effectiveItemHead } from '../../../../../verify/read.js';
/** Native computation of automatic submitted-head returns; callers supply no conflict assertion [V4,H16]. */
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { repoInfo } from '../../../../../git/index.js';
import { trunkMerge } from '../../../../../merge/index.js';
import { Refused } from '../../../../../kernel/index.js';

/** Compute evidence only for this exact native board and current submitted head. */
export function computeConflictReturn(board, id, actor) {
  const root = board.db.prepare("SELECT agent_path FROM agent WHERE agent_id='coordinator'").get()?.agent_path;
  const file = board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  let native = false;
  try { native = Boolean(root && file && realpathSync(join(repoInfo(root).commonDir, 'pullboard', 'board.sqlite')) === realpathSync(file)); } catch { /* Unreadable or imported paths fail closed. */ }
  if (!native) throw new Refused('COORDINATOR_ONLY', 'automatic conflict return requires this board\'s registered native repository');
  const item = board.db.prepare('SELECT * FROM item WHERE item_id=?').get(id);
  if (!item || item.item_status !== 'submitted' || !item.item_commit) throw new Refused('NOT_SUBMITTED', `item #${id} is not submitted`);
  if (!board.db.prepare('SELECT agent_id FROM agent WHERE agent_id=?').get(actor)) throw new Refused('NOT_JOINED', 'join before selecting a review');
  const head = effectiveItemHead(board, item) ?? item.item_commit;
  const merge = trunkMerge(root, head);
  if (!merge.files?.length) throw new Refused('NOT_CONFLICTING', 'the submitted head merges cleanly; no automatic return is needed');
  const fields = { version: 4, id: randomUUID(), board: board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='board_id'").get().meta_value,
    item: item.item_id, actor, head, trunk: merge.commit, files: merge.files, at: board.clock.now().toISOString(),
    submission: board.db.prepare("SELECT event_id FROM event WHERE item_id=? AND event_kind='submit' ORDER BY event_id DESC LIMIT 1").get(item.item_id).event_id };
  const receipt = { ...fields, digest: createHash('sha256').update(JSON.stringify(fields)).digest('hex') };
  return receipt;
}

/** Convert a native automatic request to evidence, rejecting mixed caller assertions. */
export function computedReturnArgs(board, args) {
  if (args[1]?.automaticConflict !== true) return args;
  if (args[1].conflict !== undefined || args[1].computedConflict !== undefined) throw new Refused('COORDINATOR_ONLY', 'automatic conflict return accepts no caller conflict assertion');
  const { automaticConflict, ...options } = args[1];
  return [args[0], { ...options, computedConflict: computeConflictReturn(board, args[0], options.agentId) }];
}
