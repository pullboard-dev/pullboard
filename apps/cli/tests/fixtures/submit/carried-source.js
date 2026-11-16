/** The carried-source submit case, shared by the topic-parent and merge-commit files so each runs in its own process [V4,C7,V16]. */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import {
  readFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  coordinatorLocal,
  runLocal,
  submitSettled,
} from '../../../journeys/submit/gate/local.js';
import {
  privateRepo,
  builderRepo,
  put,
  commitAll,
  seedGraph,
} from './gate.js';

/**
 * Register the case that submits a source change carried by the given mode ('topic parent' or 'merge commit').
 * Each caller file registers one mode, so the two real submits run in separate processes.
 */
export function carriedSourceCase(mode) {
  test(`affected tests include source changes carried by a ${mode} [V4,C7,V16]`, async (t) => {
    let box = privateRepo(t);
    put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node --test', affectedTests: 'node --test' }));
    seedGraph(box, true);
    // The pulled gate runs in the runner's checkout without this test's environment, so the marker path is written into the importer.
    const marker = join(box.dir, 'merged-test-ran.log');
    put(box.root, 'test/a.test.js', [
      "import assert from 'node:assert/strict';",
      "import { appendFileSync } from 'node:fs';",
      "import { value } from '../src/middle.js';",
      `appendFileSync(${JSON.stringify(marker)}, 'ran\\n');`,
      'assert.equal(value, 1);',
    ].join('\n'));
    box = builderRepo(box, [], { plumbing: true });
    assert.equal((await coordinatorLocal(box, 'add', 'build', 'Merged source', '--check', 'true')).code, 0);
    assert.equal((await runLocal(box, 'claim', '1')).code, 0);
    const branch = box.git('branch', '--show-current');
    box.git('checkout', '-q', '-b', 'topic');
    put(box.root, mode === 'topic parent' ? 'src/a.js' : 'src/notes.js', 'export const value = 2;\n');
    commitAll(box, 'feat(core): topic source [G1]');
    box.git('checkout', '-q', branch);
    if (mode === 'merge commit') {
      put(box.root, 'src/other.js', 'export const other = false;\n');
      commitAll(box, 'feat(core): unrelated source [G1]');
      box.git('merge', '--no-ff', '--no-commit', 'topic');
      put(box.root, 'src/a.js', 'export const value = 2;\n');
      commitAll(box, 'feat(core): resolve merged source [G1]');
    } else box.git('merge', '--no-ff', '-q', 'topic', '-m', 'feat(core): merge topic source [G1]');
    assert.equal(box.git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3, 'the candidate really has two parents');
    // The unchanged importer runs on its own, outside submit: importing it evaluates its assertion against the merged source.
    await assert.rejects(import(pathToFileURL(join(box.root, 'test/a.test.js')).href), { code: 'ERR_ASSERTION' }, 'the unchanged importer detects the merged source regression');
    rmSync(marker);
    const refused = await submitSettled(t, box, (...args) => runLocal(box, ...args));
    assert.equal(refused.code, 1, refused.out || refused.err);
    assert.equal(refused.receipt.gate.green, false, 'the pulled gate came back red');
    assert.match(refused.err, /test\/a\.test\.js/u, 'the red names the affected importer');
    assert.match(JSON.stringify(refused.gateJob), /ERR_ASSERTION/u);
    assert.equal(readFileSync(marker, 'utf8'), 'ran\nran\n', 'submit executes the transitive importer against the candidate and exact main');
  });
}
