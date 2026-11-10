import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fixtureCommittedGraph } from '../../tests/fixtures/testkit.js';
import { explainObservations } from '../../src/io/commands/red.js';

test('red explain finds only closure commits between recorded green and red [C7]', () => {
  const fixture = fixtureCommittedGraph('red-explain-');
  const root = fixture.root;
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const save = (file, value) => { fixture.put(file, value); return fixture.commit(); };
  const file = 'packages/cell/demo.test.js', source = 'packages/cell/logic.js';
  fixture.put(file, "import './logic.js';\n");
  const green = save(source, 'export const n = 1;\n', 'initial');
  save('unrelated.txt', 'unrelated\n', 'unrelated');
  const red = save(source, 'export const n = 2;\n');
  const stable = 'TypeError @ packages/cell/logic.js#execute';
  const closure = () => ({ closures: new Map([[file, { files: [file, source] }]]) });
  const result = explainObservations(root, file, [{ commit: green, result: 'green' }, { commit: red, result: 'red', stable }], closure);
  assert.equal(result.green, green); assert.equal(result.red, red); assert.equal(result.stable, stable);
  assert.equal(result.frame, source); assert.equal(result.function, 'execute');
  assert.deepEqual(result.suspects.map(row => [row.commit, row.item]), [[red, null]]);
  assert.match(result.suspects[0].diff, /\+export const n = 2/u);
  const unknown = explainObservations(root, file, [{ commit: red, result: 'red' }], () => ({ closures: new Map() }));
  assert.equal(unknown.green, null); assert.equal(unknown.frame, null); assert.equal(unknown.suspects, null);
  assert.throws(() => explainObservations(root, '../secret', [], closure), /repository-relative/u);
});
