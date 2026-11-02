/** Real file dispatch enforces a committed per-file budget and its accepted-main ratchet [C7]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runFixtureChild } from './fixture-child.js';
import { readTestFileBudgets } from '../packages/gate/src/shell/test-file-budget-policy.js';
import { testFileBudgetPath } from '../packages/gate/src/shell/test-file-budget-policy.js';
import { writePlacementIndex } from '../packages/gate/src/shell/test-economics-index.js';
import { indexedStageSelection } from '../packages/gate/src/shell/test-economics-index.js';

const runner = fileURLToPath(new URL('../bin/run-tests.js', import.meta.url));

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-file-budget-'));
  const main = join(directory, 'main'), candidate = join(directory, 'candidate');
  mkdirSync(main);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (cwd, ...args) => {
    const result = runFixtureChild('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.name', 'Fixture'); git(main, 'config', 'user.email', 'fixture@example.test');
  writeFileSync(join(main, 'pullboard.json'), JSON.stringify({ gate: 'true' }));
  writeFileSync(join(main, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(main, 'slow.test.js'), "import {test} from 'node:test'; test('slow fixture [C7]', async()=>{await new Promise(done=>setTimeout(done,40));});\n");
  writeFileSync(join(main, 'later.test.js'), "import {test} from 'node:test'; test('later fixture [C7]',()=>{});\n");
  const path = testFileBudgetPath('slow.test.js');
  mkdirSync(dirname(join(main, path)), { recursive: true });
  writeFileSync(join(main, path), JSON.stringify({ version: 1, file: 'slow.test.js', ms: 1 }));
  git(main, 'add', '-A'); git(main, 'commit', '-qm', 'fixture main');
  git(main, 'worktree', 'add', '-qb', 'candidate', candidate);
  const run = (cwd = candidate, files = ['slow.test.js', 'later.test.js']) => runFixtureChild(process.execPath, [runner, ...files], {
    cwd, env: { ...process.env, PULLBOARD_MACHINE_HOME: join(directory, 'machine') }, encoding: 'utf8', detached: true,
  });
  return { candidate, git, path, run };
}

test('an over-budget file fails with its observed runtime, while audit placement passes [C7]', t => {
  const box = fixture(t);
  const red = box.run(), output = `${red.stdout ?? ''}${red.stderr ?? ''}`;
  assert.equal(red.status, 1, output);
  assert.match(output, /slow\.test\.js took \d+ms, over its 1ms test file budget/u);
  assert.match(output, /later fixture \[C7\]/u, 'a budget failure does not discard other test output');
  const subdirectory = join(box.candidate, 'subdirectory');
  mkdirSync(subdirectory);
  const subdir = box.run(subdirectory, ['../slow.test.js']);
  assert.equal(subdir.status, 1);
  assert.match(`${subdir.stdout ?? ''}${subdir.stderr ?? ''}`, /slow\.test\.js took \d+ms/u, 'budgets use repository-relative paths');
  writePlacementIndex(box.candidate, { version: 1, files: [{ file: 'slow.test.js', tier: 'audit', testInputs: [] }] });
  const derived = box.run();
  assert.equal(derived.status, 1, 'a derived placement cannot grant a budget exemption');
  writeFileSync(join(box.candidate, box.path), JSON.stringify({ version: 1, file: 'slow.test.js', ms: 1, placement: 'audit' }));
  box.git(box.candidate, 'add', box.path); box.git(box.candidate, 'commit', '-qm', 'move to audit');
  writePlacementIndex(box.candidate, { version: 1, files: [{ file: 'slow.test.js', tier: 'submit', testInputs: [] }] });
  assert.deepEqual(indexedStageSelection(box.candidate, ['slow.test.js'], 'submit'), []);
  assert.deepEqual(indexedStageSelection(box.candidate, ['slow.test.js'], 'audit'), ['slow.test.js']);
  const green = box.run();
  assert.equal(green.status, 0, `${green.stdout ?? ''}${green.stderr ?? ''}`);
});

test('a candidate cannot loosen or remove an accepted file limit [C7]', t => {
  const box = fixture(t);
  writeFileSync(join(box.candidate, box.path), JSON.stringify({ version: 1, file: 'slow.test.js', ms: 2 }));
  box.git(box.candidate, 'add', box.path); box.git(box.candidate, 'commit', '-qm', 'loosen');
  assert.throws(() => readTestFileBudgets(box.candidate, ['slow.test.js']), /may not increase from 1ms to 2ms/u);
  assert.throws(() => readTestFileBudgets(box.candidate, []), /may not increase from 1ms to 2ms/u, 'unselected rows cannot loosen');
  box.git(box.candidate, 'rm', '-q', box.path, 'pullboard.json'); box.git(box.candidate, 'commit', '-qm', 'remove');
  assert.throws(() => readTestFileBudgets(box.candidate, ['slow.test.js']), /may not increase from 1ms/u);
  mkdirSync(dirname(join(box.candidate, box.path)), { recursive: true });
  writeFileSync(join(box.candidate, box.path), JSON.stringify({ version: 1, file: 'slow.test.js' }));
  box.git(box.candidate, 'add', box.path); box.git(box.candidate, 'commit', '-qm', 'malformed');
  assert.throws(() => readTestFileBudgets(box.candidate, ['slow.test.js']), /invalid test file budget row/u);
});
