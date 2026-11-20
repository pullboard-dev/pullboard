/** Real bundled starter command execution and baseline controls [I1,V2]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  bundledBlueprints,
  readBlueprint,
} from '../../../../../packages/blueprints/index.js';
import {
  checkBaseline,
  prepareCheckBaseline,
} from '../../../../../packages/gate/heavy.js';
import { runFixtureChild } from '../child.js';

/** Exercise each real bundled shell command, retaining all failures so both defects reproduce. */
export function assertStarterChecks({ emptyRepo, freshBoard, json }) {
  const failures = [];
  for (const name of bundledBlueprints()) {
    const box = emptyRepo();
    const started = box.run('init', '--blueprint', name);
    assert.equal(started.status, 0, started.stdout + started.stderr);
    const lane = join(box.repo, 'app');
    mkdirSync(lane, { recursive: true });
    const items = json(box, 'list', '--all').items;
    for (const item of items) {
      assert.equal(item.item_check_baseline ?? null, null, 'blueprint add never executes a check');
      const command = `trap 'printf "\\n__starter_cwd__%s\\n" "$(pwd -P)"' EXIT; ${item.item_check}`;
      const ran = runFixtureChild('/bin/sh', ['-c', command], { cwd: box.repo, env: box.env, encoding: 'utf8' });
      const observed = /__starter_cwd__([^\n]+)/u.exec(ran.stdout)?.[1];
      try { assert.equal(observed, realpathSync(lane), `${name}: ${item.item_check} executes in its lane, even before its test runner exists`); }
      catch (error) { failures.push(error); }
    }
    assert.equal(items.length, readBlueprint(name).items.length, `${name} files every starter`);
  }
  for (const owned of ['services/my api/', "-app's/"]) {
    const chosen = freshBoard({ lanes: { service: { owns: [owned], specs: [] } } });
    const folder = join(chosen.repo, owned);
    mkdirSync(folder, { recursive: true });
    const placed = json(chosen, 'blueprint', 'add', 'web-app');
    const first = json(chosen, 'show', String(placed.items[0].id));
    assert.equal(first.item_lane, 'service');
    const ran = runFixtureChild('/bin/sh', ['-c', `trap 'printf "\\n__starter_cwd__%s\\n" "$(pwd -P)"' EXIT; ${first.item_check}`],
      { cwd: chosen.repo, env: chosen.env, encoding: 'utf8' });
    try { assert.equal(/__starter_cwd__([^\n]+)/u.exec(ran.stdout)?.[1], realpathSync(folder), `the actual chosen lane folder ${owned} is used without shell option or quote interpretation`); }
    catch (error) { failures.push(error); }
  }
  const ambiguous = freshBoard({ lanes: { app: { owns: ['src/', 'test/'], specs: [] } } });
  const rootItems = json(ambiguous, 'blueprint', 'add', 'web-app').items;
  assert.equal(json(ambiguous, 'show', String(rootItems[0].id)).item_check, 'npm test',
    'multiple owned folders keep repo-root semantics rather than choosing one arbitrarily');

  const custom = freshBoard();
  const supplied = readBlueprint('web-app');
  const check = 'node -e "process.stdout.write(process.cwd())"';
  writeFileSync(join(custom.repo, 'local.json'), JSON.stringify({ ...supplied, items: [{ ...supplied.items[0], check }] }));
  const filed = json(custom, 'blueprint', 'add', 'local.json');
  assert.equal(json(custom, 'show', String(filed.items[0].id)).item_check, check,
    'a local blueprint with a bundled-looking name retains its exact supplied command');

  const command = `${JSON.stringify(process.execPath)} -e 'process.exit(23)'`;
  const baseline = freshBoard({ gate: command });
  const actual = runFixtureChild('/bin/sh', ['-c', command], { cwd: baseline.repo, env: baseline.env, encoding: 'utf8' });
  assert.equal(actual.status, 23, 'the command equal to the committed gate really fails');
  const prepared = prepareCheckBaseline(baseline.repo, command);
  const measured = checkBaseline(baseline.repo, command, { main: baseline.git('rev-parse', 'HEAD') });
  try { assert.equal(prepared.result, 'pending', 'preparation cannot certify a repo gate green without executing it'); }
  catch (error) { failures.push(error); }
  try { assert.equal(measured.result, 'red', 'executing a failing repo-gate command reports red'); }
  catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('\n'));
}
