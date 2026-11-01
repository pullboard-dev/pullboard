/** Read only optional project cell metadata, without loading the analyzer or executing project modules [B35,C7]. */
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Refused } from '../../../kernel/index.js';

/** Projects without a cells plan still recognize explicit packages/apps paths and cell names. */
export function criterionCells(root) {
  const index = join(root, 'bin/cells-plan.json');
  if (!existsSync(index)) return [];
  try {
    return JSON.parse(readFileSync(index, 'utf8')).cells.map(row => {
      if (typeof row.file !== 'string' || !/^bin\/cells-plan\/[\w-]+\.json$/u.test(row.file)) throw new Error('invalid shard path');
      const cell = JSON.parse(readFileSync(join(root, row.file), 'utf8'));
      return { name: cell.name, root: cell.root, paths: cell.paths.flatMap(pair => pair.slice(0, 2)) };
    });
  } catch (error) { throw new Refused('ITEM_SIZE_PLAN', `cannot read criterion cell mapping: ${error.message}`, 'repair bin/cells-plan.json and its named shards, then add the item again'); }
}
