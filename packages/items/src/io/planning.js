/** Derive scheduler conflicts from one exact-main map; unknown source retains file-level custody [N2,N20,C7]. */
import { compareItemPredictions } from '../../../codemap/light.js';
import { predictItemFunctions } from '../../../codemap/light.js';
import { readCodeMap } from '../../../codemap/light.js';
import { git } from '../../../git/index.js';
import { mainCheckout } from '../../../git/index.js';
import { repoInfo } from '../../../git/index.js';
import { itemFileCollisions } from '../logic/files.js';
import { liveClaimCollisions } from '../logic/overlap.js';
import { join } from 'node:path';

const snapshots = new WeakMap();
const flights = new WeakMap();

/** Predict an in-flight row once per exact-main map; a changed item arrives as a new row object. */
function predictRow(map, row) {
  let rows = flights.get(map);
  if (!rows) { rows = new WeakMap(); flights.set(map, rows); }
  let prediction = rows.get(row);
  if (!prediction) { prediction = predictItemFunctions(map, row); rows.set(row, prediction); }
  return prediction;
}

/** Capture once per board read; a dirty, absent or stale primary checkout cannot relax an existing blocker. */
function schedulingMap(board) {
  if (snapshots.has(board)) return snapshots.get(board);
  let map = null;
  try {
    const root = board.gitRoot;
    if (root) {
      const trunk = mainCheckout(root);
      if (trunk?.branch === 'refs/heads/main' && trunk.commit) {
        const cached = readCodeMap(join(repoInfo(root).commonDir, 'pullboard', 'code-map.json'), trunk.commit);
        const tree = git(root, ['rev-parse', `${trunk.commit}^{tree}`]).trim();
        if (cached?.sourceTree === tree && cached.modules.every(module => typeof module.path === 'string'
          && Array.isArray(module.functions) && module.functions.every(fn => typeof fn.id === 'string' && typeof fn.name === 'string' && Array.isArray(fn.calls))
          && Array.isArray(module.tests))) map = cached;
      }
    }
  } catch { /* Unknown source preserves the existing file collision, never an optimistic prediction. */ }
  snapshots.set(board, map);
  return map;
}

/** Keep declared and observed file blocks unless both exact-map function predictions prove disjoint. */
export function itemCollisionPlan(board, item, items, observations = new Map(), map = schedulingMap(board)) {
  const blockers = [], warnings = [], tests = new Set();
  const flying = items.filter(other => !(other.item_id === item.item_id || !['claimed', 'submitted', 'verified'].includes(other.item_status)
    || other.item_status === 'verified' && other.item_merged_commit));
  // File and live-claim collisions run once against the whole list; the per-pair lookups run only when that answer is not empty.
  const anyObserved = liveClaimCollisions(item, flying, observations).length > 0;
  const anyFiles = itemFileCollisions(item, flying).length > 0;
  let mine = null;
  for (const other of flying) {
    const observed = anyObserved ? liveClaimCollisions(item, [other], observations) : [];
    if (observed.length) { blockers.push(...observed); continue; }
    const files = anyFiles ? itemFileCollisions(item, [other]) : [];
    if (map) mine ??= predictItemFunctions(map, item);
    const predicted = map ? compareItemPredictions(map, mine, predictRow(map, other)) : null;
    if (!predicted?.known) { blockers.push(...files); continue; }
    if (predicted.shared.length) {
      blockers.push(`#${item.item_id} waits for #${other.item_id} (${other.item_status}) on functions ${predicted.shared.join(', ')}`);
    } else if (predicted.adjacent.length && (!predicted.tests.length || predicted.uncovered.length)) {
      blockers.push(`#${item.item_id} waits for #${other.item_id}: call-adjacent functions have no mapped tests`);
    } else if (predicted.adjacent.length) {
      warnings.push(`#${item.item_id} is call-adjacent to #${other.item_id}: ${predicted.adjacent.join(', ')}; cross-run tests: ${predicted.tests.join(', ') || 'not detected'}`);
      for (const test of predicted.tests) tests.add(test);
    }
  }
  return { blockers, warnings, tests: [...tests].sort() };
}
