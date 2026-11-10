/** Launcher for the cuts check: engine.js owns the checks, this file binds the snapshot-aware path-map reader and files cut items [C7,D3]. */
import { spawnSync } from 'node:child_process';
import {
  checkCuts as engineCheckCuts,
  addedPlacementProblems as engineAddedPlacementProblems,
  frontDoorBypasses as engineFrontDoorBypasses,
} from './engine.js';
import { planEntryProblems } from '../../../../index.js';
import { cutItemCommands } from '../../../../index.js';
import { cutTitle } from '../../../../index.js';
import { importCuts } from '../../../../index.js';
import { Refused } from '../../../../../kernel/index.js';
import { readPathMap } from '../git.js';

export { ownerFor, onlyForwards, withDeclaredLoads } from './engine.js';
export { ownedStayProblems, processEntry, retiredProblems } from '../../../../index.js';

/** The engine's checks, reading rename metadata through the snapshot-aware reader. */
export const checkCuts = (root, plan, name, options = {}) => engineCheckCuts(root, plan, name, { readPathMap, ...options });
export const entryPlacementProblems = (root, plan, files, sharedMap) => planEntryProblems(root, plan, files, sharedMap, readPathMap);
export const addedPlacementProblems = (baseRoot, mergedRoot, readers) => engineAddedPlacementProblems(baseRoot, mergedRoot, { readPathMap, ...readers });
export const frontDoorBypasses = (root, plan, name, options = {}) => engineFrontDoorBypasses(root, plan, name, { readPathMap, ...options });

/** Read existing items through the real joined CLI; one exact stable title identifies one importing cell's item. */
function existingCuts(root, plan) {
  const run = spawnSync('pullboard', ['list', 'core', '--all', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Refused('CELLS_PLAN_FILE', `pullboard list failed: ${run.stderr?.trim()}; use a joined checkout`);
  const items = JSON.parse(run.stdout).items ?? [];
  const ids = new Map();
  for (const group of importCuts(plan)) {
    const found = items.find(item => item.item_title === cutTitle(group.cell));
    if (found) ids.set(group.cell, String(found.item_id));
  }
  return ids;
}

/** Dry-run or file missing cut items, retaining completed adds when an interrupted invocation is rerun. */
export function fileCuts(root, plan, yes) {
  const ids = existingCuts(root, plan);
  for (const [cell, id] of ids) console.log(`${cell} import cuts already #${id}`);
  for (const { group, args } of cutItemCommands(plan, ids)) {
    if (!yes) { console.log(['pullboard', ...args.map(arg => JSON.stringify(arg))].join(' ')); continue; }
    const run = spawnSync('pullboard', args, { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (run.status !== 0) throw new Refused('CELLS_PLAN_FILE', `pullboard add for ${group.cell} cuts failed: ${run.stderr?.trim()}; fix it and rerun to skip filed items`);
    const id = /"item_id"\s*:\s*(\d+)/u.exec(run.stdout)?.[1] ?? /#(\d+)/u.exec(run.stdout)?.[1];
    if (!id) throw new Refused('CELLS_PLAN_FILE', `pullboard add for ${group.cell} cuts printed no id; inspect the board before rerunning`);
    console.log(`${group.cell} import cuts #${id}`);
  }
  if (!yes) console.log('dry run: nothing filed; add --yes to file independent import-cut items');
}
