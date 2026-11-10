/** A real submit follows a registered test-tree guard through a rename and refuses a deleted one [V4,C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { builderRepo } from '../../tests/fixtures/submit/gate.js';
import { commitAll } from '../../tests/fixtures/submit/gate.js';
import { privateRepo } from '../../tests/fixtures/submit/gate.js';
import { put } from '../../tests/fixtures/submit/gate.js';
import { seedGraph } from '../../tests/fixtures/submit/gate.js';

test('a real submit follows a registered guard through a rename and refuses a deleted one [V4,C7]', (t) => {
  /** Accepted main holds a test-tree guard that records where it ran; the builder checkout renames or deletes it. */
  function project() {
    let box = privateRepo(t);
    put(box.root, 'pullboard.json', JSON.stringify({ gate: 'node --test', affectedTests: 'node --test',
      submitGate: 'landing', shared: ['pullboard.json'] }));
    seedGraph(box);
    const marker = join(box.dir, 'guard.log');
    box.env.INVARIANT_MARKER = marker;
    put(box.root, 'test/guard.test.js', ['/** @pullboard-test-input test-tree */',
      "import { appendFileSync } from 'node:fs';",
      "appendFileSync(process.env.INVARIANT_MARKER, 'guard ' + (import.meta.dirname.endsWith('/test/area') ? 'at the new path' : 'at the old path') + '\\n');",
    ].join('\n') + '\n');
    put(box.root, 'test/c.test.js', "throw new Error('unrelated test must stay deferred');\n");
    put(box.root, 'bin/run-tests.js', 'export const version = 1;\n');
    commitAll(box);
    box = builderRepo(box, ['bin/run-tests.js']);
    assert.equal(box.coordinator('add', 'build', 'Guard fixture', '--check', 'node -e "process.exit(0)"').code, 0);
    assert.equal(box.run('claim', '1').code, 0);
    return { box, marker };
  }

  const renamed = project();
  mkdirSync(join(renamed.box.root, 'test/area'), { recursive: true });
  renamed.box.git('mv', 'test/guard.test.js', 'test/area/guard.test.js');
  put(renamed.box.root, 'src/a.js', 'export const value = 2;\n');
  commitAll(renamed.box, 'feat(core): rename the guard [G1]');
  const accepted = renamed.box.run('submit', '1', '--json', '--infra', 'the guard fixture renames a registered guard');
  assert.equal(accepted.code, 0, accepted.err + accepted.out);
  assert.equal(existsSync(renamed.marker), true, 'the renamed guard executed during the submit');
  assert.equal(readFileSync(renamed.marker, 'utf8'), 'guard at the new path\n',
    'it ran once, as a guard, at its new path and not at the old one');

  const deleted = project();
  rmSync(join(deleted.box.root, 'test/guard.test.js'));
  put(deleted.box.root, 'src/a.js', 'export const value = 2;\n');
  commitAll(deleted.box, 'feat(core): delete the guard [G1]');
  const refused = deleted.box.run('submit', '1', '--json', '--infra', 'the guard fixture deletes a registered guard');
  assert.notEqual(refused.code, 0, 'deleting a registered guard is refused');
  assert.match(refused.err + refused.out, /BAD_CONFIG/u);
  assert.match(refused.err + refused.out, /registryGuards file test\/guard\.test\.js is missing or unreadable/u);
  assert.equal(existsSync(deleted.marker), false, 'a deleted guard never runs');
});
