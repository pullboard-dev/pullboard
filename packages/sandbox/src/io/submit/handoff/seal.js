import { itemFolderIdentity } from '../../../../../items/index.js';
import { itemFolderPath } from '../../../../../items/index.js';
import { mainPolicy } from '../../trusted/policy/committed.js';
/** Capture queued source at the genuine registered origin before the native writer; replay consumes values only. */
import { fileSystemAdapter } from '../../../../../fs/index.js';
import { join } from 'node:path';
import {
  repoInfo,
  contains,
  headCommit,
  headTree,
  isClean,
  invalidateGitFacts,
} from '../../../../../git/index.js';
import { prepareItemPatchSubmit } from '../../../../../items/index.js';
import { itemPatchDigest } from '../../../../../items/index.js';
import { getItem } from '../../../../../store/index.js';
import { Refused } from '../../../../../kernel/index.js';

const fs = fileSystemAdapter();

/** Retain exact native source and companions; source-only validation creates no job or reservation. */
export function sealSubmitHandoffQueue(board, id, options, { sourceOnly = false } = {}) {
  if (!sourceOnly && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(options.job ?? '')) throw new Refused('BAD_SUBMIT_HANDOFF', 'capture a new native job identifier');
  const seatRoot = board.db.prepare('SELECT agent_path FROM agent WHERE agent_id=?').get(options.agentId)?.agent_path;
  const candidate = seatRoot && itemFolderPath(seatRoot, id);
  const root = candidate && itemFolderIdentity(board, candidate)?.item === id && headCommit(candidate) === options.commit ? candidate : seatRoot;
  // Main may have moved since this command first read it; a rewind must refuse here, so read it fresh [V4,H16,E18].
  invalidateGitFacts({ keepIdentity: true });
  const file = board.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  if (!root || !file || fs.realpath(join(repoInfo(root).commonDir, 'pullboard', 'board.sqlite')) !== fs.realpath(file)
    || !contains(root, options.main, mainPolicy(root).commit) || headCommit(root) !== options.commit || headTree(root) !== options.tree || !isClean(root)) {
    throw new Refused('SUBMIT_HANDOFF_SOURCE', 'queue only the clean registered builder head on this board');
  }
  const companion = prepareItemPatchSubmit(root, board, getItem(board, id), options.commit);
  if (itemPatchDigest(board, id, options.commit) !== options.companionDigest
    || (companion?.commit ?? options.commit) !== options.executionCommit
    || (companion?.tree ?? options.tree) !== options.executionTree) {
    throw new Refused('SUBMIT_HANDOFF_CHANGED', 'capture the exact current source and companion composition again');
  }
  return sourceOnly ? { ...options, root } : options;
}
