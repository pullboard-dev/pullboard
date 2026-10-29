/** @pullboard-test-input source-tree */
/** @pullboard-test-loads bin/cells-plan.js */
/** New source must be placed through the bounded plan writer before native submit runs its check [C7]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  readPlan,
  writePlan,
  placePath,
} from '../bin/cells-plan.js';
import { requirePlannedSource } from '../src/submit-preflight.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { runFixtureChild } from './fixture-child.js';

const SOURCE = join(import.meta.dirname, '..');
const PLAN = join(SOURCE, 'bin/cells-plan.js');

/** A real committed source checkout with the actual plan, native agents and normal hooks. */
function plannedProject(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('node check.cjs');
  const marker = join(box.dir, 'check-ran');
  writeFileSync(join(box.repo, 'check.cjs'), `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'ran\\n');\n`);
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  writePlan(box.repo, readPlan(SOURCE));
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.lanes.web.owns.push('src/', 'bin/cells-plan.json', 'bin/cells-plan/');
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config, null, 2) + '\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: initialize the real placement fixture');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  return { ...box, marker };
}

/** Keep actual native command failures in every setup assertion. */
function success(box, cwd, ...args) {
  const run = box.run(cwd, ...args, '--no-next', '--json');
  assert.equal(run.code, 0, run.out + run.err);
  return JSON.parse(run.out);
}

test('native submit names an unplanned source before its check, then the same placed source submits [C7]', t => {
  const box = plannedProject(t);
  const id = success(box, box.repo, 'add', 'web', 'Place the new source', '--specs', 'G1',
    '--criterion', 'the added source is planned', '--check', 'node check.cjs', '--wait').item.item_id;
  assert.equal(existsSync(box.marker), true, 'the real add baseline completed its check');
  success(box, box.web, 'claim', String(id));
  mkdirSync(join(box.web, 'src'), { recursive: true });
  writeFileSync(join(box.web, 'src/plan-gate-added.js'), 'export const value = 1;\n');
  box.git(box.web, 'add', 'src/plan-gate-added.js');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): add the real source [G1]');
  // The completed add baseline is setup; observe only check executions caused by this submit.
  rmSync(box.marker);
  assert.equal(existsSync(box.marker), false, 'the submit observation starts without the setup marker');
  const refused = box.run(box.web, 'submit', String(id), '--no-next', '--json');
  assert.equal(JSON.parse(refused.out).error.code, 'CELLS_PLAN_UNPLACED', refused.out + refused.err);
  assert.match(refused.out, /src\/plan-gate-added\.js/);
  assert.match(refused.out, /node bin\/cells-plan\.js --place/);
  assert.equal(existsSync(box.marker), false, 'no check executes before the placement refusal');
  const before = readPlan(box.web);
  const placed = runFixtureChild(process.execPath, [PLAN, '--place', 'src/plan-gate-added.js', '--cell', 'items'],
    { cwd: box.web, env: box.env, encoding: 'utf8' });
  assert.equal(placed.status, 0, placed.stdout + placed.stderr);
  const after = readPlan(box.web);
  for (const old of before.cells) {
    const current = after.cells.find(cell => cell.name === old.name);
    assert.deepEqual(current.paths.slice(0, old.paths.length), old.paths, 'all existing path rows retain exact order');
    assert.deepEqual(current.cuts, old.cuts);
    assert.deepEqual(current.reexports, old.reexports);
  }
  assert.deepEqual(after.stays, before.stays);
  assert.deepEqual(after.cells.find(cell => cell.name === 'items').paths.at(-1),
    ['src/plan-gate-added.js', 'packages/items/src/shell/plan-gate-added.js', 'rule']);
  box.git(box.web, 'add', 'bin/cells-plan.json', 'bin/cells-plan');
  box.git(box.web, 'commit', '-q', '-m', 'chore: place the added source');
  const submitted = success(box, box.web, 'submit', String(id));
  assert.equal(submitted.gate.green, true);
  assert.equal(existsSync(box.marker), true, 'the real check now runs normally');
});

test('placement rejects unknown cells, duplicate paths, symlinks and out-of-scope paths without rewriting the plan [C7]', t => {
  const box = plannedProject(t);
  mkdirSync(join(box.repo, 'src'), { recursive: true });
  writeFileSync(join(box.repo, 'src/plan-place-negative.js'), 'export const value = 2;\n');
  box.git(box.repo, 'add', 'src/plan-place-negative.js');
  const before = readPlan(box.repo);
  assert.throws(() => placePath(box.repo, 'src/plan-place-negative.js', { cell: 'not-a-cell' }), /existing cell/);
  assert.throws(() => placePath(box.repo, '../src/plan-place-negative.js', { cell: 'items' }), /in-scope/);
  assert.throws(() => placePath(box.repo, 'docs/not-source.md', { stay: true }), /in-scope/);
  assert.deepEqual(readPlan(box.repo), before);
  symlinkSync('plan-place-negative.js', join(box.repo, 'src/plan-place-link.js'));
  box.git(box.repo, 'add', 'src/plan-place-link.js');
  assert.throws(() => placePath(box.repo, 'src/plan-place-link.js', { cell: 'items' }), /regular source/);
  placePath(box.repo, 'src/plan-place-negative.js', { stay: true });
  assert.deepEqual(readPlan(box.repo).stays.slice(0, before.stays.length), before.stays);
  assert.throws(() => placePath(box.repo, 'src/plan-place-negative.js', { stay: true }), /already placed/);
});

test('committed plan deletion and malformed shards refuse; an unstaged placement cannot authorize source [C7]', t => {
  const box = plannedProject(t);
  const base = box.git(box.repo, 'rev-parse', 'HEAD');
  assert.throws(() => requirePlannedSource(box.repo, '0'.repeat(40), base), /presence could not be read from Git/);
  mkdirSync(join(box.repo, 'src'), { recursive: true });
  writeFileSync(join(box.repo, 'src/plan-snapshot-only.js'), 'export const value = 3;\n');
  box.git(box.repo, 'add', 'src/plan-snapshot-only.js');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: add unplaced fixture source');
  const head = box.git(box.repo, 'rev-parse', 'HEAD');
  placePath(box.repo, 'src/plan-snapshot-only.js', { cell: 'items' });
  assert.throws(() => requirePlannedSource(box.repo, base, head), /plan-snapshot-only\.js/);
  box.git(box.repo, 'reset', '--hard', head);
  box.git(box.repo, 'rm', 'bin/cells-plan.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: remove fixture plan for the negative control');
  assert.throws(() => requirePlannedSource(box.repo, base, box.git(box.repo, 'rev-parse', 'HEAD')), /restore the committed cells plan/);
  box.git(box.repo, 'reset', '--hard', head);
  writeFileSync(join(box.repo, 'bin/cells-plan/13-items.json'), '{ malformed JSON');
  box.git(box.repo, 'add', 'bin/cells-plan/13-items.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: corrupt only the private plan shard');
  assert.throws(() => requirePlannedSource(box.repo, base, box.git(box.repo, 'rev-parse', 'HEAD')), /valid committed cells plan JSON/);
});

test('removing an existing placement cannot strand its retained committed source [C7]', t => {
  const box = plannedProject(t);
  mkdirSync(join(box.repo, 'src'), { recursive: true });
  const file = 'src/plan-retained-source.js';
  writeFileSync(join(box.repo, file), 'export const retained = true;\n');
  box.git(box.repo, 'add', file);
  placePath(box.repo, file, { cell: 'items' });
  box.git(box.repo, 'add', 'bin/cells-plan.json', 'bin/cells-plan');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: commit the placed source');
  const base = box.git(box.repo, 'rev-parse', 'HEAD');
  requirePlannedSource(box.repo, base, base);
  const plan = readPlan(box.repo);
  const cell = plan.cells.find(row => row.name === 'items');
  cell.paths = cell.paths.filter(([from]) => from !== file);
  writePlan(box.repo, plan);
  box.git(box.repo, 'add', 'bin/cells-plan.json', 'bin/cells-plan');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: remove only the placement for a negative control');
  assert.throws(() => requirePlannedSource(box.repo, base, box.git(box.repo, 'rev-parse', 'HEAD')), /plan-retained-source\.js/);
});

test('ordinary repositories without an accepted cells plan retain their source contract [C7]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const base = box.git(box.repo, 'rev-parse', 'HEAD');
  mkdirSync(join(box.repo, 'src'), { recursive: true });
  writeFileSync(join(box.repo, 'src/ordinary-project.js'), 'export const ordinary = true;\n');
  box.git(box.repo, 'add', 'src/ordinary-project.js');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: keep ordinary project source independent of cells');
  assert.equal(existsSync(join(box.repo, 'bin/cells-plan.json')), false);
  requirePlannedSource(box.repo, base, box.git(box.repo, 'rev-parse', 'HEAD'));
});
