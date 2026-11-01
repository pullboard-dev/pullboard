/** @pullboard-test-input source-tree */
/** Real recorded tool commands regenerate conflicting source, with fresh full proof and no inherited verdict [C7,V4,V6]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runFixtureChild } from './fixture-child.js';
import { privateRepo } from './submit-gate-fixture.js';
import { builderRepo } from './submit-gate-fixture.js';
import { commitAll } from './submit-gate-fixture.js';
import { put } from './submit-gate-fixture.js';
import { cellLintBaseline } from '../packages/codemap/index.js';
import { writeCellLintBaseline } from '../packages/codemap/index.js';
import { gitPath } from '../packages/git/index.js';
import { recordedToolCommits } from '../packages/git/index.js';

/** Execute the real installed cell tool against this small project, never a simulated transform. */
function tool(box, name, ...args) {
  const result = runFixtureChild(process.execPath, [fileURLToPath(new URL(`../bin/${name}`, import.meta.url)), ...args],
    { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return result.stdout;
}

/** A claimed project with real cell placement, a lint baseline and a deliberately deferred ordinary full gate. */
function project(t) {
  const main = privateRepo(t);
  const marker = join(main.dir, 'full-gate.txt');
  put(main.root, 'pullboard.json', JSON.stringify({ gate: `FULL_GATE_MARKER='${marker}' node --test test/work.test.js`,
    submit: { handoff: true }, submitGate: 'landing', submitInvariants: [], registryGuards: [], shared: ['pullboard.json'] }));
  put(main.root, 'src/leaf.js', 'export const value = 1;\n');
  put(main.root, 'test/work.test.js', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { value } from '../src/leaf.js';
test('the leaf matches accepted main [G1]', () => {
  assert.equal(value, 1);
  if (process.env.FULL_GATE_MARKER) appendFileSync(process.env.FULL_GATE_MARKER, 'fresh full proof\\n');
});
`);
  put(main.root, 'bin/cells-plan/seed.json', JSON.stringify({ source: 'fixture', sha256: 'none', order: ['leaf'],
    cells: { leaf: ['src/leaf.js'] }, tests: {} }));
  commitAll(main);
  tool(main, 'cells-plan.js', '--write');
  commitAll(main);
  // The accepted fixture budget includes the temporary bridge shims a move deliberately creates.
  // Measure a real reversible move, then restore the original source before accepting that budget.
  const previewCustody = join(main.dir, 'preview-custody');
  mkdirSync(previewCustody);
  const preview = JSON.parse(tool(main, 'cells-move.js', '--apply', 'src/leaf.js', 'packages/leaf/src/core/leaf.js', 'packages/leaf/index.js', 'Expose the leaf value.', previewCustody));
  const baseline = cellLintBaseline(JSON.parse(tool(main, 'cell-lints.js', '--report')));
  tool(main, 'cells-move.js', '--undo', preview.record);
  writeCellLintBaseline(main.root, baseline, { initialize: true });
  commitAll(main);
  const box = builderRepo(main, ['packages/', 'bin/']);
  assert.equal(box.coordinator('add', 'build', 'Recorded tool change', '--check', 'node --test test/work.test.js').code, 0);
  assert.equal(box.run('claim', '1').code, 0);
  return { main, box, marker };
}

/** Produce one actual tool commit, retaining its command separately from the required commit prose. */
function move(box, dir) {
  const custody = join(dir, 'custody');
  mkdirSync(custody);
  tool(box, 'cells-move.js', '--apply', 'src/leaf.js', 'packages/leaf/src/core/leaf.js', 'packages/leaf/index.js', 'Expose the leaf value.', custody);
  return commitAll(box, 'refactor(core): move the leaf behind its door [G1]');
}

/** Main changes the exact file the tool replaced, and its corresponding accepted expectation. */
function advance(main) {
  put(main.root, 'src/leaf.js', 'export const value = 2;\n');
  const before = readFileSync(join(main.root, 'test/work.test.js'), 'utf8');
  put(main.root, 'test/work.test.js', before.replace('assert.equal(value, 1)', 'assert.equal(value, 2)'));
  return commitAll(main, 'feat(core): advance the accepted leaf [G1]');
}

test('submit replays a recorded cell move on main, proves the new head fully and attaches no old verdict [C7,V4,V6]', t => {
  const { main, box, marker } = project(t);
  const original = move(box, main.dir);
  tool(box, 'cells-plan.js', '--check');
  tool(box, 'cell-lints.js', '--check');
  const before = main.git('rev-parse', 'HEAD');
  assert.equal(recordedToolCommits(box.root, before, original)[0].commands[0].tool, 'cells-move');
  const currentMain = advance(main);
  assert.equal(existsSync(marker), false);
  const submitted = box.run('submit', '1', '--json', '--infra', 'recorded tool regeneration fixture');
  const diagnostic = gitPath(box.root, `pullboard-tool-regeneration-${original}.log`);
  assert.equal(submitted.code, 0, submitted.err + submitted.out + (existsSync(diagnostic) ? readFileSync(diagnostic, 'utf8').slice(-10_000) : ''));
  const result = JSON.parse(submitted.out);
  const head = box.git('rev-parse', 'HEAD');
  assert.notEqual(head, original);
  assert.equal(box.git('rev-parse', 'HEAD^'), currentMain);
  assert.match(readFileSync(join(box.root, 'packages/leaf/src/core/leaf.js'), 'utf8'), /value = 2/u);
  assert.ok(existsSync(marker), 'regeneration runs the full gate even when normal submit defers it');
  assert.equal(result.full, true);
  const item = JSON.parse(box.run('show', '1', '--json').out);
  assert.equal(item.item_status, 'submitted');
  assert.equal(item.item_commit, head);
  assert.equal(item.item_verdict, null);
  assert.equal(item.item_verified_by, null);
  assert.ok(item.proofReceipts.some(receipt => receipt.kind === 'submit' && receipt.commit === head), 'the new head has its own proof');
  assert.ok(!item.proofReceipts.some(receipt => receipt.kind === 'submit' && receipt.commit === original));
  assert.equal(recordedToolCommits(box.root, currentMain, head)[0].commands[0].tool, 'cells-move', 'another main advance can replay this new head too');
});

test('a hand edit mixed into a tool result retains the ordinary main-conflict refusal and its source [C7,V6]', t => {
  const { main, box, marker } = project(t);
  move(box, main.dir);
  put(box.root, 'src/leaf.js', readFileSync(join(box.root, 'src/leaf.js'), 'utf8') + '// handwritten addition\n');
  const original = commitAll(box, 'refactor(core): retain a handwritten addition [G1]');
  const currentMain = advance(main);
  assert.equal(recordedToolCommits(box.root, currentMain, original), null);
  const submitted = box.run('submit', '1', '--json', '--infra', 'mixed-source refusal fixture');
  assert.notEqual(submitted.code, 0);
  assert.match(submitted.err + submitted.out, /MERGE_CONFLICT/u);
  assert.equal(box.git('rev-parse', 'HEAD'), original);
  assert.match(readFileSync(join(box.root, 'src/leaf.js'), 'utf8'), /handwritten addition/u);
  assert.equal(existsSync(marker), false, 'handwritten conflict still fails before a gate');
});
