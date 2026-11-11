import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { receiptBody } from '../../../../packages/gate/index.js';
import { emptyRepo } from '../../tests/fixtures/blueprint.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fixtureCommittedGraph } from '../../tests/fixtures/testkit.js';
import { fixtureProjectPolicy } from '../../tests/fixtures/testkit.js';
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

test('red explain reads receipt history through the real CLI [C7]', () => {
  const box = emptyRepo();
  box.git = (...args) => runFixtureGit(args, { cwd: box.repo, env: box.env });
  fixtureProjectPolicy(box.repo);
  writeFileSync(join(box.repo, 'package.json'), JSON.stringify({ type: 'module' }) + '\n');
  const file = 'test/sample.test.js', source = 'src/logic.js';
  mkdirSync(join(box.repo, 'test'), { recursive: true });
  mkdirSync(join(box.repo, 'src'), { recursive: true });
  writeFileSync(join(box.repo, file), "import '../src/logic.js';\n");
  writeFileSync(join(box.repo, source), 'export const n = 1;\n');
  box.git('add', '-A'); box.git('commit', '-qm', 'test(fixture): green baseline [C7]');
  const green = box.git('rev-parse', 'HEAD'), greenTree = box.git('rev-parse', 'HEAD^{tree}');
  writeFileSync(join(box.repo, 'unrelated.txt'), 'unrelated\n');
  box.git('add', '-A'); box.git('commit', '-qm', 'test(fixture): unrelated change [C7]');
  writeFileSync(join(box.repo, source), 'export const n = 2;\n');
  box.git('add', '-A'); box.git('commit', '-qm', 'fix(fixture): break #123 [C7]');
  const red = box.git('rev-parse', 'HEAD'), redTree = box.git('rev-parse', 'HEAD^{tree}');
  const folder = join(box.repo, '.git', 'pullboard', 'gate-receipts');
  mkdirSync(folder, { recursive: true });
  const stable = 'TypeError @ src/logic.js#execute';
  const make = (id, head, tree, passed) => ({ version: 1, id, kind: 'gate', head, tree, main: null,
    command: 'a'.repeat(64), green: passed, failures: passed ? [] : [{ file, name: 'case' }],
    load: { average: [0, 0, 0], cpus: 1, freeMB: 100 }, at: '2026-01-01T00:00:00.000Z',
    testOutcomes: [{ file, name: 'case', passed, skipped: false }],
    ...(passed ? {} : { failureSignatures: { version: 5, failures: [{ file, name: 'case', signature: 'b'.repeat(64), stable }] } }) });
  // Synthetic canonical receipts live only in this private fixture, never on a live board.
  for (const row of [make('11111111-1111-4111-8111-111111111111', green, greenTree, true), make('22222222-2222-4222-8222-222222222222', red, redTree, false)]) {
    const body = receiptBody(row); assert.ok(body); writeFileSync(join(folder, `${row.id}.json`), body);
  }
  const result = box.run('red', 'explain', file);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`Last green: ${green}`, 'u'));
  assert.match(result.stdout, new RegExp(`First observed red: ${red}`, 'u'));
  assert.match(result.stdout, /Deepest repository frame: src\/logic\.js#execute/u);
  assert.match(result.stdout, /Cluster: TypeError @ src\/logic\.js#execute/u);
  assert.match(result.stdout, new RegExp(`Suspect: ${red} #123`, 'u'));
  assert.match(result.stdout, /\+export const n = 2/u);
  const structured = box.run('red', 'explain', file, '--json');
  assert.equal(structured.status, 0, structured.stdout + structured.stderr);
  assert.equal(JSON.parse(structured.stdout).file, file);
  const missing = box.run('red', 'explain', 'test/missing.test.js');
  assert.equal(missing.status, 0, missing.stdout + missing.stderr);
  assert.match(missing.stdout, /Last green: unknown/u);
  assert.match(missing.stdout, /Suspects: unknown/u);
});
