/** @pullboard-test-input source-tree */
/** @pullboard-test-loads bin/cells-plan.js */
/** A builder's new source may carry exactly its own canonical placement across lane boundaries [L3,C7]. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readPlan, writePlan, placePath } from '../bin/cells-plan.js';
import { planRowChange } from '../src/plan-row-change.js';
import { requirePlannedSource } from '../packages/items/index.js';
import { plannedProject } from './placement-project.fixture.js';
import { success } from './placement-project.fixture.js';
import { runFixtureChild } from './fixture-child.js';

/** Join a real view seat and claim a completed-baseline item through the native CLI. */
function ownPlacementFixture(t) {
  const box = plannedProject(t, { companionLanes: true });
  const view = join(box.dir, 'own-placement-view');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', view, 'main');
  success(box, view, 'join', 'view');
  const id = success(box, box.repo, 'add', 'view', 'Place an owned new file', '--specs', 'G1',
    '--criterion', 'The builder owns the new file and only adds its canonical row.', '--check', 'node check.cjs', '--wait').item.item_id;
  success(box, view, 'claim', String(id));
  const file = 'src/view/own-placement-added.js';
  mkdirSync(join(view, 'src/view'), { recursive: true });
  writeFileSync(join(view, file), 'export const placed = true;\n');
  box.git(view, 'add', file);
  placePath(view, file, { cell: 'app:view' });
  box.git(view, 'add', 'bin/cells-plan.json', 'bin/cells-plan');
  return { ...box, view, id, file };
}

test('a view commit creating its own file and one plan row passes the hook and native submit [L3,C7]', t => {
  const box = ownPlacementFixture(t);
  box.git(box.view, 'commit', '-q', '-m', 'feat(view): add source and its own placement [G1]');
  rmSync(box.marker);
  const submitted = success(box, box.view, 'submit', String(box.id));
  assert.equal(submitted.gate.green, true);
  assert.equal(existsSync(box.marker), true, 'the native gate ran after the committed placement passed');
  assert.equal(box.git(box.view, 'status', '--porcelain'), '');
});

test('adding an owned new-file row cannot lend authority to editing an existing row [L3,C7]', t => {
  const box = ownPlacementFixture(t);
  const plan = readPlan(box.view);
  const cell = plan.cells.find(cell => cell.name === 'app:view');
  const original = structuredClone(cell.paths[0]);
  cell.paths[0][1] = cell.paths[0][1].replace('/shell/', '/core/');
  assert.notEqual(cell.paths[0][1], original[1]);
  writePlan(box.view, plan);
  box.git(box.view, 'add', 'bin/cells-plan');
  const before = box.git(box.view, 'rev-parse', 'HEAD');
  const refused = runFixtureChild('git', ['commit', '-m', 'feat(view): alter a foreign row [G1]'],
    { cwd: box.view, env: box.env, encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout + refused.stderr, /existing plan row/);
  assert.ok((refused.stdout + refused.stderr).includes(original[0]), 'refusal names the existing source row');
  assert.equal(box.git(box.view, 'rev-parse', 'HEAD'), before, 'the refused hook creates no commit');
  assert.ok(box.git(box.view, 'status', '--porcelain').includes(box.file), 'the original staged work remains available');
});

test('native view submit validates its core companion placement on the composed source [C7,V4]', t => {
  const box = plannedProject(t, { companionLanes: true });
  const view = join(box.dir, 'placement-view'), core = join(box.dir, 'placement-core');
  for (const [path, lane] of [[view, 'view'], [core, 'core']]) {
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', path, 'main');
    success(box, path, 'join', lane);
  }
  const author = success(box, core, 'whoami').id;
  const id = success(box, box.repo, 'add', 'view', 'Place through a core companion', '--specs', 'G1',
    '--criterion', 'The new view source is placed by its core companion.', '--check', 'node check.cjs', '--wait').item.item_id;
  success(box, view, 'claim', String(id));
  const file = 'src/view/plan-companion-added.js';
  mkdirSync(join(view, 'src/view'), { recursive: true });
  writeFileSync(join(view, file), 'export const companionPlaced = true;\n');
  box.git(view, 'add', file);
  box.git(view, 'commit', '-q', '-m', 'feat(view): add the companion-placed source [G1]');
  const source = box.git(view, 'rev-parse', 'HEAD');
  rmSync(box.marker);
  const refused = box.run(view, 'submit', String(id), '--no-next', '--json');
  assert.equal(JSON.parse(refused.out).error.code, 'CELLS_PLAN_UNPLACED', refused.out + refused.err);
  assert.match(refused.out, /src\/view\/plan-companion-added\.js/);
  assert.equal(existsSync(box.marker), false, 'the unplaced bare source never runs its check');
  placePath(view, file, { cell: 'app:view' });
  const patch = join(box.dir, 'core-placement.patch');
  writeFileSync(patch, box.git(view, 'diff', '--', 'bin/cells-plan.json', 'bin/cells-plan') + '\n');
  box.git(view, 'restore', '--', 'bin/cells-plan.json', 'bin/cells-plan');
  assert.equal(box.git(view, 'status', '--porcelain'), '', 'the builder keeps its clean original source');
  success(box, box.repo, 'patch', 'attach', String(id), patch, '--key', 'core-placement', '--author', author, '--source', source);
  const submitted = success(box, view, 'submit', String(id));
  assert.equal(submitted.gate.green, true);
  assert.equal(submitted.gate.companion.source, source);
  assert.notEqual(submitted.gate.companion.commit, source, 'the actual gate proves the composed source');
  assert.equal(existsSync(box.marker), true, 'the composed source now reaches its real check');
  assert.throws(() => requirePlannedSource(view, box.git(box.repo, 'rev-parse', 'HEAD'), source), /plan-companion-added\.js/,
    'the companion never lends its placement to the bare builder source');
});


/** Keep the pure authority boundary explicit; native journeys above supply real Git/index reads. */
function syntheticPlanChange(change = value => value, ownNewFile = path => path === 'src/view/new.css') {
  const path = 'bin/cells-plan/39-app-view.json';
  const index = { cells: [{ name: 'app:view', order: 39, file: path }], stays: [] };
  const cell = { name: 'app:view', order: 39, root: 'apps/view', paths: [
    ['src/view/old.css', 'apps/view/src/shell/view/old.css', 'seed'],
  ] };
  const before = { 'bin/cells-plan.json': index, [path]: cell };
  const after = structuredClone(before);
  after[path].paths.push(['src/view/new.css', 'apps/view/src/shell/view/new.css', 'rule']);
  change(after, path);
  const read = data => file => data[file] && ({ mode: '100644', bytes: Buffer.from(JSON.stringify(data[file])) });
  return planRowChange(path, { before: read(before), after: read(after), ownNewFile });
}

test('synthetic plan metadata cannot authorize existing files, foreign files, duplicate targets or other plan edits [L3,C7]', () => {
  assert.equal(syntheticPlanChange().allowed, true);
  assert.equal(syntheticPlanChange(value => value, () => false).allowed, false, 'Git creation and lane ownership are both required');
  const mutations = [
    (data, path) => { data[path].paths[0][1] += '-changed'; },
    (data, path) => { data[path].root = 'apps/other'; },
    data => { data['bin/cells-plan.json'].stays.push({ path: 'src/view/new.css' }); },
    (data, path) => { data[path].paths.at(-1)[1] = 'apps/view/src/shell/wrong.css'; },
    (data, path) => { data[path].paths.at(-1)[2] = 'seed'; },
    (data, path) => { data[path].paths.push([...data[path].paths.at(-1)]); },
    (data, path) => { data[path].paths.at(-1)[0] = 'src/view/../escape.css'; },
  ];
  for (const mutate of mutations) assert.equal(syntheticPlanChange(mutate).allowed, false);
});
