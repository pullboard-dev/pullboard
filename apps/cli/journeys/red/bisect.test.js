import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fixtureCommittedGraph } from '../../tests/fixtures/testkit.js';
import { bisectRed } from '../../src/io/commands/red.js';

test('red bisect finds the one breaking commit among eight in at most four probes [C7]', () => {
  const fixture = fixtureCommittedGraph('red-bisect-');
  const root = fixture.root;
  const file = 'packages/cell/demo.test.js', source = 'packages/cell/logic.js';
  fixture.put(file, "import './logic.js';\n");
  const save = (value) => { fixture.put(source, `export const n = ${value};\n`); return fixture.commit(); };
  const green = save(0);
  const commits = [1, 2, 3, 4, 5, 6, 7, 8].map(save);
  const breaking = commits[5];
  const order = commits.map(commit => commit);
  const probed = [];
  const probe = commit => { probed.push(commit); return order.indexOf(commit) < order.indexOf(breaking); };
  const closure = () => ({ closures: new Map([[file, { files: [file, source] }]]) });
  const found = bisectRed(root, file, { green, red: commits[7], probe, closureReader: closure });
  assert.equal(found.commit, breaking);
  assert.equal(found.candidates, 8);
  assert.ok(probed.length <= 4, `probed ${probed.length} times`);
  assert.deepEqual(found.probes, probed);
  assert.equal(execFileSync('git', ['rev-parse', breaking], { cwd: root, encoding: 'utf8' }).trim(), breaking);
});

test('red bisect skips commits outside the test closure and refuses an unknown closure [C7]', () => {
  const fixture = fixtureCommittedGraph('red-bisect-skip-');
  const root = fixture.root;
  const file = 'packages/cell/demo.test.js', source = 'packages/cell/logic.js';
  fixture.put(file, "import './logic.js';\n");
  fixture.put(source, 'export const n = 0;\n');
  const green = fixture.commit();
  fixture.put('unrelated.txt', 'a\n'); fixture.commit();
  fixture.put(source, 'export const n = 1;\n'); const red = fixture.commit();
  const probed = [];
  const found = bisectRed(root, file, { green, red, probe: commit => { probed.push(commit); return true; },
    closureReader: () => ({ closures: new Map([[file, { files: [file, source] }]]) }) });
  assert.equal(found.commit, red); assert.equal(found.candidates, 1); assert.deepEqual(probed, []);
  assert.throws(() => bisectRed(root, file, { green, red, probe: () => true, closureReader: () => ({ closures: new Map() }) }), /no import closure/u);
});
