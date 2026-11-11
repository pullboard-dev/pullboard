/** @pullboard-test-input packages/codemap/data/plan/45-app-view.json packages/codemap/data/plan/cells.json */
/** Real public submits distinguish merged main rows from a builder's own foreign edits [L3,C7,V4]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readPlan } from '../../../../packages/codemap/index.js';
import { writePlan } from '../../../../packages/codemap/index.js';
import { placePath } from '../../../../packages/codemap/index.js';
import { plannedProject } from '../../tests/fixtures/placement.js';
import { success } from '../../tests/fixtures/placement.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { planRowChange } from '../../../../packages/commits/light.js';

/** Reproduce the original merge shape: the builder's new row precedes a row independently accepted on main. */
function mergedPlacement(t) {
  const box = plannedProject(t, { companionLanes: true });
  const view = join(box.dir, 'merged-placement-view');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', view, 'main');
  success(box, view, 'join', 'view');
  const id = success(box, box.repo, 'add', 'view', 'Merge independently placed main source', '--specs', 'G1',
    '--criterion', 'The view source keeps its placement when an unrelated main placement is merged.',
    '--check', 'node check.cjs', '--wait').item.item_id;
  success(box, view, 'claim', String(id));
  const claimed = success(box, view, 'show', String(id));
  const ownFile = 'src/view/doctrine.css';
  mkdirSync(join(view, 'src/view'), { recursive: true });
  writeFileSync(join(view, ownFile), '.own { color: blue; }\n');
  box.git(view, 'add', ownFile);
  placePath(view, ownFile, { cell: 'app:view' });
  box.git(view, 'add', 'packages/codemap/data/plan');
  box.git(view, 'commit', '-q', '-m', 'feat(view): add an owned placement [G1]');
  const builderPlan = readPlan(view);
  const mainFile = 'src/view/dashboard.css';
  writeFileSync(join(box.repo, mainFile), '.main { color: green; }\n');
  box.git(box.repo, 'add', mainFile);
  placePath(box.repo, mainFile, { cell: 'app:view' });
  box.git(box.repo, 'add', 'packages/codemap/data/plan');
  box.git(box.repo, 'commit', '-q', '-m', 'feat(view): accept an independent main placement [G1]');
  const main = box.git(box.repo, 'rev-parse', 'HEAD');
  const mainRow = readPlan(box.repo).cells.find(cell => cell.name === 'app:view').paths.find(row => row[0] === mainFile);
  const merged = runFixtureChild('git', ['merge', '--no-commit', '--no-ff', 'main'],
    { cwd: view, env: box.env, encoding: 'utf8' });
  assert.ok([0, 1].includes(merged.status), merged.stdout + merged.stderr);
  // Resolve only the two independently appended rows, retaining the builder row before the accepted main row.
  builderPlan.cells.find(cell => cell.name === 'app:view').paths.push(mainRow);
  writePlan(view, builderPlan);
  box.git(view, 'add', 'packages/codemap/data/plan');
  box.git(view, 'commit', '-q', '-m', 'chore: compose independent placement rows [G1]');
  assert.notEqual(JSON.parse(claimed.item_frozen).policy.commit, main, 'the claim really retains older policy');
  assert.equal(box.git(view, 'show', `HEAD:${mainFile}`), box.git(box.repo, 'show', `HEAD:${mainFile}`),
    'the merged main source is unchanged');
  const paths = readPlan(view).cells.find(cell => cell.name === 'app:view').paths;
  assert.ok(paths.findIndex(row => row[0] === ownFile) < paths.findIndex(row => row[0] === mainFile));
  rmSync(box.marker);
  return { ...box, view, id, main, mainFile };
}

test('a view item merges a main-owned plan change and submits its unchanged main row plus owned creation [L3,C7,V4]', t => {
  const box = mergedPlacement(t);
  const submitted = success(box, box.view, 'submit', String(box.id));
  assert.equal(submitted.gate.green, true);
  assert.equal(existsSync(box.marker), true, 'the real gate ran after ownership admitted the composed source');
  assert.equal(success(box, box.view, 'show', String(box.id)).item_status, 'submitted');
  assert.equal(box.git(box.repo, 'rev-parse', 'HEAD'), box.main, 'submit does not rewrite accepted main');
});

test('a builder editing the accepted main row itself still fails public submit before its gate [L3,C7,V4]', t => {
  const box = mergedPlacement(t);
  const plan = readPlan(box.view);
  const row = plan.cells.find(cell => cell.name === 'app:view').paths.find(row => row[0] === box.mainFile);
  row[1] = row[1].replace('/shell/', '/core/');
  writePlan(box.view, plan);
  box.git(box.view, 'add', 'packages/codemap/data/plan');
  // A private commit-tree object models an externally authored bad commit; it claims no successful hook or proof.
  const parent = box.git(box.view, 'rev-parse', 'HEAD');
  const invalid = box.git(box.view, 'commit-tree', box.git(box.view, 'write-tree'), '-p', parent,
    '-m', 'fixture: unauthorized foreign-row edit');
  box.git(box.view, 'reset', '--hard', invalid);
  const refused = box.run(box.view, 'submit', String(box.id), '--no-next', '--json');
  assert.equal(refused.code, 1, refused.out + refused.err);
  assert.equal(JSON.parse(refused.out).error.code, 'OUTSIDE_LANE');
  assert.match(refused.out, /dashboard\.css/);
  assert.equal(existsSync(box.marker), false, 'no gate runs for the unauthorized foreign edit');
  assert.equal(success(box, box.view, 'show', String(box.id)).item_status, 'claimed');
});

/** Probe row authority only; these synthetic blobs are not native claim or execution evidence. */
function insertedRows(change = () => {}) {
  const path = 'packages/codemap/data/plan/45-app-view.json';
  const rows = ['first', 'last'].map(name => [`src/view/${name}.css`, `apps/view/src/io/view/${name}.css`, 'seed']);
  const before = { 'packages/codemap/data/plan/cells.json': { cells: [{ name: 'app:view', order: 39, file: path }], stays: [] },
    [path]: { name: 'app:view', order: 39, root: 'apps/view', paths: rows } };
  const after = structuredClone(before);
  after[path].paths.splice(1, 0, ['src/view/new.css', 'apps/view/src/io/view/new.css', 'rule']);
  change(after[path].paths);
  const read = state => file => state[file] && { mode: '100644', bytes: Buffer.from(JSON.stringify(state[file])) };
  return planRowChange(path, { before: read(before), after: read(after), ownNewFile: file => file === 'src/view/new.css' });
}

test('an owned insertion preserves every old row and cannot hide deletion, reordering or duplication [L3,C7]', () => {
  assert.equal(insertedRows().allowed, true);
  for (const change of [
    rows => rows.splice(0, 1),
    rows => rows.reverse(),
    rows => rows.push([...rows[0]]),
    rows => { rows[0][1] += '-changed'; },
    rows => { rows[1][0] = 'src/view/foreign.css'; },
  ]) assert.equal(insertedRows(change).allowed, false);
});
