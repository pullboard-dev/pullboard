/**
 * The affected-submit cases that run a real pulled gate per mode, shared by the two merge-base test files in journeys/submit/gate [V4,C7,V16].
 * Why: three gate trips in one file passed its 180 s budget on a loaded runner, so each file registers some of the modes.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { runChildTests } from '../../../../../packages/gate/tests/fixtures/child-tests.js';
import { runLocal } from './local.js';
import { submitSettled } from './local.js';
import { whenRunnerSettles } from '../runner/local-start.js';
import { fileFixtureItem } from '../testkit.js';
import { privateRepo } from './gate.js';
import { put } from './gate.js';
import { commitAll } from './gate.js';
import { seedGraph } from './gate.js';

export function affectedSubmitModeCases(test, modes) {
  for (const mode of modes) {
  test(`affected submit on main includes a ${mode} since its claim [V4,C7,V16]`, async (t) => {
    const box = privateRepo(t);
    put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node --test', affectedTests: 'node --test', lanes: { core: { owns: ['src/', 'test/'], specs: ['G'] } } }));
    seedGraph(box);
    // The pulled gate runs in the runner's checkout without this test's environment, so the marker path is written into the importer.
    const marker = join(box.dir, 'main-importer-ran.log');
    put(box.root, 'test/a.test.js', [
      "import assert from 'node:assert/strict';",
      "import { appendFileSync } from 'node:fs';",
      "import { value } from '../src/middle.js';",
      `appendFileSync(${JSON.stringify(marker)}, 'ran\\n');`,
      'assert.equal(value, 1);',
    ].join('\n'));
    commitAll(box);
    await fileFixtureItem(box, box.root, { lane: 'coordinator', title: 'Main checkout source', check: 'true', run: (cwd, ...args) => runLocal({ ...box, root: cwd }, ...args) });
    const claimed = await runLocal(box, 'claim', '1');
    assert.equal(claimed.code, 0, claimed.err);
    if (mode === 'deleted source') {
      box.git('rm', 'src/a.js');
      commitAll(box, 'refactor(core): delete source on main [G1]');
    } else {
      box.git('checkout', '-q', '-b', 'topic');
      put(box.root, mode === 'topic parent' ? 'src/a.js' : 'src/notes.js', 'export const value = 2;\n');
      commitAll(box, 'feat(core): topic source [G1]');
      box.git('checkout', '-q', 'main');
      if (mode === 'merge commit') {
        put(box.root, 'src/other.js', 'export const other = false;\n');
        commitAll(box, 'feat(core): unrelated main source [G1]');
        box.git('merge', '--no-ff', '--no-commit', 'topic');
        put(box.root, 'src/a.js', 'export const value = 2;\n');
        commitAll(box, 'feat(core): resolve main merge [G1]');
      } else box.git('merge', '--no-ff', '-q', 'topic', '-m', 'feat(core): merge topic into main [G1]');
      assert.equal(box.git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3);
    }
    assert.equal(box.git('branch', '--show-current'), 'main', 'submit runs in the actual main checkout');
    // Process-level: the unchanged importer runs under its own node --test, not the CLI.
    const standalone = runChildTests(['test/a.test.js'], { cwd: box.root, env: box.env });
    assert.equal(standalone.status, 1, 'the unchanged importer detects the source regression');
    assert.match(standalone.stdout, mode === 'deleted source' ? /ERR_MODULE_NOT_FOUND/u : /ERR_ASSERTION/u);
    rmSync(marker, { force: true });
    // The candidate is main itself, so main's own run of the importer names no case: the board records the red as unknown and keeps waiting for a main receipt that never keys; the journey judges the job's own receipt.
    const refused = await submitSettled(t, box, (...args) => runLocal(box, ...args), [], { unknownSettles: true });
    assert.equal(refused.code, 1, refused.out || refused.err);
    assert.equal(refused.receipt.gate.green, false, 'the pulled gate came back red');
    assert.match(refused.err, /test\/a\.test\.js/u, 'the red names the affected importer');
    assert.match(JSON.stringify(refused.gateJob), mode === 'deleted source' ? /ERR_MODULE_NOT_FOUND/u : /ERR_ASSERTION/u);
    // The main run of the importer is queued as the gate settles; it has run once the marker holds a second line.
    if (mode !== 'deleted source') await whenRunnerSettles(box.env, () => existsSync(marker) && readFileSync(marker, 'utf8').split('\n').length > 2, { deadlineMs: 60_000, what: 'the main run of the unchanged importer' });
    if (mode !== 'deleted source') assert.equal(readFileSync(marker, 'utf8'), 'ran\nran\n', 'submit executes the unchanged transitive importer against the candidate and exact main');
  });
}
}
