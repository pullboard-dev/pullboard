/** Read only optional project cell metadata, without loading the analyzer or executing project modules [B35,C7]. */
import { fileSystemAdapter } from '../../../fs/index.js';
import { join } from 'node:path';
import { Refused } from '../../../kernel/index.js';

const fs = fileSystemAdapter();

/** Projects without a cells plan still recognize explicit packages/apps paths. */
export function criterionCells(root) {
  const index = join(root, 'packages/codemap/data/plan/cells.json');
  if (!fs.exists(index)) return [];
  try {
    return JSON.parse(fs.readFile(index, 'utf8')).cells.map(row => {
      if (typeof row.file !== 'string' || !/^packages\/codemap\/data\/plan\/[\w-]+\.json$/u.test(row.file)) throw new Error('invalid shard path');
      const cell = JSON.parse(fs.readFile(join(root, row.file), 'utf8'));
      return { name: cell.name, root: cell.root, paths: cell.paths.flatMap(pair => pair.slice(0, 2)) };
    });
  } catch (error) { throw new Refused('ITEM_SIZE_PLAN', `cannot read criterion cell mapping: ${error.message}`, 'repair packages/codemap/data/plan/cells.json and its named shards, then add the item again'); }
}
