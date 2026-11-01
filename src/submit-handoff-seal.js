import { mainPolicy } from '../packages/sandbox/index.js';
/** Capture queued source at the genuine registered origin before the native writer; replay consumes values only. */
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  repoInfo,
  headCommit,
  headTree,
  isClean,
} from './git.js';
import { prepareItemPatchSubmit } from './item-patch-submit.js';
import { itemPatchDigest } from './item-patch-state.js';
import { getItem } from '../packages/store/index.js';
import { Refused } from '../packages/kernel/index.js';

/** A queue captures only this board's clean registered builder head and exact deterministic companions. */
export function sealSubmitHandoffQueue(board, id, options) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(options.job ?? '')) throw new Refused('BAD_SUBMIT_HANDOFF', 'capture a new native job identifier');
  const root = board.db.prepare('SELECT agent_path FROM agent WHERE agent_id=?').get(options.agentId)?.agent_path;
  const file = board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  if (!root || !file || realpathSync(join(repoInfo(root).commonDir, 'pullboard', 'board.sqlite')) !== realpathSync(file)
    || mainPolicy(root).commit !== options.main || headCommit(root) !== options.commit || headTree(root) !== options.tree || !isClean(root)) {
    throw new Refused('SUBMIT_HANDOFF_SOURCE', 'queue only the clean registered builder head on this board');
  }
  const companion = prepareItemPatchSubmit(root, board, getItem(board, id), options.commit);
  if (itemPatchDigest(board, id, options.commit) !== options.companionDigest
    || (companion?.commit ?? options.commit) !== options.executionCommit
    || (companion?.tree ?? options.tree) !== options.executionTree) {
    throw new Refused('SUBMIT_HANDOFF_CHANGED', 'capture the exact current source and companion composition again');
  }
  return options;
}
