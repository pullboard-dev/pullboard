/** A real submit follows a registered test-tree guard through a rename and refuses a deleted one [V4,C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { builderRepo } from '../../tests/fixtures/submit/gate.js';
import { commitAll } from '../../tests/fixtures/submit/gate.js';
import { privateRepo } from '../../tests/fixtures/submit/gate.js';
import { put } from '../../tests/fixtures/submit/gate.js';
import { seedGraph } from '../../tests/fixtures/submit/gate.js';
import { submitWithEnv } from './gate/local.js';

test('a real submit follows a registered guard through a rename and refuses a deleted one [V4,C7]', async (t) => {
  /** Accepted main holds a test-tree guard that records where it ran; the builder checkout renames or deletes it. */
  function project() {
    let box = privateRepo(t);
    put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node --test', affectedTests: 'node --test',
      submitGate: 'landing', shared: ['pullboard.json'] }));
    seedGraph(box);
    // The runner's sandbox keeps a guard from writing outside its clone, so the guard fails when it runs anywhere but the new path and the receipt names it [C7,#7725].
    put(box.root, 'test/guard.test.js', ['/** @pullboard-test-input test-tree */',
      "import { test } from 'node:test';",
      "test('guard runs at its new path', () => { if (!import.meta.dirname.endsWith('/test/area')) throw new Error('guard at the old path'); });",
    ].join('\n') + '\n');
    put(box.root, 'test/c.test.js', "throw new Error('unrelated test must stay deferred');\n");
    put(box.root, 'bin/run-tests.js', 'export const version = 1;\n');
    commitAll(box);
    box = builderRepo(box, ['bin/run-tests.js']);
    assert.equal(box.coordinator('add', 'build', 'Guard fixture', '--check', 'node -e "process.exit(0)"').code, 0);
    assert.equal(box.run('claim', '1').code, 0);
    return { box };
  }

  const renamed = project();
  mkdirSync(join(renamed.box.root, 'test/area'), { recursive: true });
  renamed.box.git('mv', 'test/guard.test.js', 'test/area/guard.test.js');
  put(renamed.box.root, 'src/a.js', 'export const value = 2;\n');
  commitAll(renamed.box, 'feat(core): rename the guard [G1]');
  // The pulled gate runs the guard on the machine's runner, so the journey waits for the settled receipt [C7,#7725].
  const accepted = await submitWithEnv(t, renamed.box, (...args) => renamed.box.run(...args), ['--infra', 'the guard fixture renames a registered guard']);
  assert.equal(accepted.code, 0, accepted.err + accepted.out);
  const ran = (accepted.receipt.gate.phases ?? []).flatMap(phase => phase.testOutcomes?.tests ?? []).filter(row => row.file === 'test/area/guard.test.js');
  assert.equal(ran.length > 0 && ran.every(row => row.passed), true, 'the renamed guard executed during the submit, as a guard, at its new path and not at the old one');

  const deleted = project();
  rmSync(join(deleted.box.root, 'test/guard.test.js'));
  put(deleted.box.root, 'src/a.js', 'export const value = 2;\n');
  commitAll(deleted.box, 'feat(core): delete the guard [G1]');
  const refused = await submitWithEnv(t, deleted.box, (...args) => deleted.box.run(...args), ['--infra', 'the guard fixture deletes a registered guard']);
  assert.notEqual(refused.code, 0, 'deleting a registered guard is refused');
  assert.match(refused.err + refused.out, /BAD_CONFIG/u);
  assert.match(refused.err + refused.out, /registryGuards file test\/guard\.test\.js is missing or unreadable/u);
  assert.equal((refused.receipt?.gate?.phases ?? []).some(phase => (phase.testOutcomes?.tests ?? []).some(row => row.file === 'test/guard.test.js')), false, 'a deleted guard never runs');
});
