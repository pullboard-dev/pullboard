/** Shell boundary for checking actual import cuts and filing their independent board items [C7,D3]. */
import { spawnSync } from 'node:child_process';
import { cellInventory } from '../src/cell-lint-inventory.js';
import { testFile } from '../src/cell-lint-inventory.js';
import { cutItemCommands } from '../src/cells-plan-cuts.js';
import { cutTitle } from '../src/cells-plan-cuts.js';
import { importCuts } from '../src/cells-plan-cuts.js';
import { readPathMap } from '../src/path-map.js';
import { mappedPath } from '../src/path-map.js';
import { Refused } from '../src/refused.js';

/** Attribute original paths, moved identities and front doors to their committed plan cell. */
function ownerFor(plan, map) {
  const paths = new Map();
  for (const cell of plan.cells) {
    paths.set(cell.frontDoor, cell.name);
    for (const [from, to] of cell.paths) for (const file of [from, to, mappedPath(map, from)]) paths.set(file, cell.name);
  }
  return file => plan.cells.find(cell => file.startsWith(`${cell.root}/`))?.name ?? paths.get(file) ?? null;
}

/** Follow actual production reachability across cells so moving a forwarding module cannot conceal a cut. */
export function checkCuts(root, plan, name) {
  const group = importCuts(plan).find(row => row.cell === name);
  if (!group) throw new Refused('CELLS_PLAN_CELL', `no import-cut group ${name}; use an importing cell from node bin/cells-plan.js --file-cuts`);
  const { edges, unknown } = cellInventory(root);
  const owner = ownerFor(plan, readPathMap(root));
  const forbidden = new Set(group.targets), problems = new Set(), seen = new Set();
  const pending = [...edges.keys()].filter(file => !testFile(file) && owner(file) === name);
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const row of unknown.filter(row => row.file === file)) problems.add(`cannot prove cut through ${file}: ${row.reason}`);
    for (const { target } of edges.get(file) ?? []) {
      if (testFile(target)) continue;
      const cell = owner(target);
      if (forbidden.has(cell)) problems.add(`${name} still imports later ${cell}: ${file} -> ${target}`);
      else pending.push(target);
    }
  }
  return [...problems].sort();
}

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
