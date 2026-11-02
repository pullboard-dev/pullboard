/** Derive scheduler conflicts from one exact-main map; unknown source retains file-level custody [N2,N20,C7]. */
import { compareItemFunctions } from '../../../codemap/index.js';
import { ensureCodeMap } from '../../../codemap/index.js';
import { git } from '../../../git/index.js';
import { mainCheckout } from '../../../git/index.js';
import { repoInfo } from '../../../git/index.js';
import { itemFileCollisions } from '../core/item-files.js';
import { liveClaimCollisions } from '../core/claim-overlap.js';
import { join } from 'node:path';

const snapshots = new WeakMap();

/** Capture once per board read; a dirty, absent or stale primary checkout cannot relax an existing blocker. */
function schedulingMap(board) {
  if (snapshots.has(board)) return snapshots.get(board);
  let map = null;
  try {
    const root = board.gitRoot;
    if (root) {
      const trunk = mainCheckout(root);
      if (trunk?.branch === 'refs/heads/main' && trunk.commit) {
        const primary = git(root, ['worktree', 'list', '--porcelain', '-z']).split('\0')[0].slice('worktree '.length);
        map = ensureCodeMap(primary, join(repoInfo(root).commonDir, 'pullboard', 'code-map.json'), trunk.commit);
      }
    }
  } catch { /* Unknown source preserves the existing file collision, never an optimistic prediction. */ }
  snapshots.set(board, map);
  return map;
}

/** Keep declared and observed file blocks unless both exact-map function predictions prove disjoint. */
export function itemCollisionPlan(board, item, items, observations = new Map()) {
  const map = schedulingMap(board), blockers = [], warnings = [], tests = new Set();
  for (const other of items) {
    if (other.item_id === item.item_id || !['claimed', 'submitted', 'verified'].includes(other.item_status)
      || other.item_status === 'verified' && other.item_merged_commit) continue;
    const files = [...new Set([...itemFileCollisions(item, [other]), ...liveClaimCollisions(item, [other], observations)])];
    const predicted = map ? compareItemFunctions(map, item, other) : null;
    if (!predicted?.known) { blockers.push(...files); continue; }
    if (predicted.shared.length) {
      blockers.push(`#${item.item_id} waits for #${other.item_id} (${other.item_status}) on functions ${predicted.shared.join(', ')}`);
    } else if (predicted.adjacent.length && !predicted.tests.length) {
      blockers.push(`#${item.item_id} waits for #${other.item_id}: call-adjacent functions have no mapped tests`);
    } else if (predicted.adjacent.length) {
      warnings.push(`#${item.item_id} is call-adjacent to #${other.item_id}: ${predicted.adjacent.join(', ')}; cross-run tests: ${predicted.tests.join(', ') || 'not detected'}`);
      for (const test of predicted.tests) tests.add(test);
    }
  }
  return { blockers, warnings, tests: [...tests].sort() };
}
