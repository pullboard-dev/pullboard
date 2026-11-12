/** @pullboard-test-input packages/codemap/data/plan/seed.json */
/** Real recorded tool commands regenerate conflicting source, with fresh full proof and no inherited verdict [C7,V4,V6]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { waitFor } from '../../tests/fixtures/gate/resource.js';
import { privateRepo } from '../../tests/fixtures/submit/gate.js';
import { builderRepo } from '../../tests/fixtures/submit/gate.js';
import { commitAll } from '../../tests/fixtures/submit/gate.js';
import { put } from '../../tests/fixtures/submit/gate.js';
import { planCellLintBaseline } from '../../../../packages/codemap/index.js';
import { writeCellLintBaseline } from '../../../../packages/codemap/index.js';
import { recordedToolCommits } from '../../../../packages/git/index.js';
import { warmAcceptedCells } from '../../../../packages/gate/index.js';
import { withMainCheckout } from '../../../../packages/landing/index.js';
import { withFileLock } from '../../../../packages/outbox/index.js';

/** Execute the real installed cell tool against this small project, never a simulated transform. */
function tool(box, name, ...args) {
  const scripts = { 'cells-plan.js': 'cells/scripts/plan.js', 'cells-move.js': 'cells/move.js', 'cell-lints.js': 'cell/scripts/lints.js' };
  assert.ok(scripts[name], `unknown cell tool: ${name}`);
  const result = runFixtureChild(process.execPath, [fileURLToPath(new URL(`../../../../packages/codemap/src/io/${scripts[name]}`, import.meta.url)), ...args],
    { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return result.stdout;
}

/** A claimed project with real cell placement, a lint baseline and a deliberately deferred ordinary full gate. */
function project(t, remove = false) {
  const main = privateRepo(t);
  const marker = join(main.dir, 'full-gate.txt');
  put(main.root, 'pullboard.json', JSON.stringify({ gate: `FULL_GATE_MARKER='${marker}' node --test test/work.test.js`,
    lanes: { build: { owns: ['src/', 'test/', 'packages/', 'apps/', 'bin/'], specs: ['G'] } },
    submit: { handoff: true }, submitGate: 'landing', submitInvariants: [], registryGuards: [], shared: ['pullboard.json'] }));
  put(main.root, 'package.json', JSON.stringify({ type: 'module', bin: './apps/fixture/index.js' }));
  put(main.root, 'apps/fixture/index.js', "import { value } from '../../src/leaf.js';\nconsole.log(value);\n");
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
  put(main.root, 'packages/codemap/data/plan/seed.json', JSON.stringify({ source: 'fixture', sha256: 'none', order: ['leaf', 'app:fixture'],
    cells: { leaf: ['src/leaf.js'], 'app:fixture': ['apps/fixture/index.js'] }, tests: {} }));
  commitAll(main);
  tool(main, 'cells-plan.js', '--write');
  commitAll(main);
  // The accepted fixture budget includes the temporary bridge shims a move deliberately creates.
  // Measure a real reversible move, then restore the original source before accepting that budget.
  const original = main.git('rev-parse', 'HEAD');
  const previewCustody = join(main.dir, 'preview-custody');
  mkdirSync(previewCustody);
  tool(main, 'cells-move.js', '--apply', 'src/leaf.js', 'packages/leaf/src/core/leaf.js', 'packages/leaf/index.js', 'Expose the leaf value.', previewCustody);
  commitAll(main); // The report reads committed path-map identities.
  const { baseline } = planCellLintBaseline(JSON.parse(tool(main, 'cell-lints.js', '--report')));
  if (remove) {
    tool(main, 'cells-plan.js', '--remove-shims', 'leaf', '--lane', 'build');
    commitAll(main);
    const afterRemoval = planCellLintBaseline(JSON.parse(tool(main, 'cell-lints.js', '--report'))).baseline;
    for (const [metric, row] of Object.entries(afterRemoval.metrics)) {
      const accepted = baseline.metrics[metric];
      for (const [key, count] of Object.entries(row.allowances)) accepted.allowances[key] = Math.max(accepted.allowances[key] ?? 0, count);
      accepted.count = Object.values(accepted.allowances).reduce((sum, count) => sum + count, 0);
    }
  }
  main.git('reset', '--hard', original); // Only this disposable private fixture checkout.
  writeCellLintBaseline(main.root, baseline, { initialize: true });
  commitAll(main);
  const box = builderRepo(main, ['packages/', 'bin/', 'apps/']);
  assert.equal(box.coordinator('add', 'build', 'Recorded tool change', '--criterion', 'the leaf moves behind its door [test]', '--specs', 'G1', '--check', 'node --test test/work.test.js').code, 0);
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
  put(main.root, 'apps/fixture/index.js', "import { value as acceptedValue } from '../../src/leaf.js';\nconsole.log(acceptedValue);\n");
  const before = readFileSync(join(main.root, 'test/work.test.js'), 'utf8');
  put(main.root, 'test/work.test.js', before.replace('assert.equal(value, 1)', 'assert.equal(value, 2)'));
  return commitAll(main, 'feat(core): advance the accepted leaf [G1]');
}

/** Read the item once its queued gate has settled; the fixture's detached worker runs the real gate. */
function settledSubmit(box) {
  const settled = () => {
    const item = JSON.parse(box.run('show', '1', '--json').out);
    return ['queued', 'running'].includes(item.queuedSubmit?.state) ? null : item;
  };
  return waitFor(settled, 'the queued regeneration gate to settle', 120_000); // budget: hang ceiling for the detached worker's real full gate.
}

for (const command of ['cells-move', 'remove-shims']) test(`submit replays recorded ${command} on main with fresh full proof and no verdict [C7,V4,V6]`, async t => {
  const { main, box, marker } = project(t, command === 'remove-shims');
  let original = move(box, main.dir);
  if (command === 'remove-shims') {
    tool(box, 'cells-plan.js', '--remove-shims', 'leaf', '--lane', 'build');
    original = commitAll(box, 'refactor(core): remove the leaf shim [G1]');
  }
  tool(box, 'cells-plan.js', '--check');
  tool(box, 'cell-lints.js', '--check');
  const before = main.git('rev-parse', 'HEAD');
  assert.equal(recordedToolCommits(box.root, before, original).at(-1).commands[0].tool, command);
  const currentMain = advance(main);
  // This private board has no background producer; build its real accepted inventory before queuing the gate.
  const previousHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = main.env.PULLBOARD_MACHINE_HOME;
  try { await warmAcceptedCells(main.root, currentMain, { withCheckout: withMainCheckout, withLock: withFileLock }); }
  finally { if (previousHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previousHome; }
  assert.equal(existsSync(marker), false);
  const submitted = box.run('submit', '1', '--wait', '--no-next', '--json', '--infra', 'recorded tool regeneration fixture');
  assert.equal(submitted.code, 0, submitted.err + submitted.out + (submitted.code ? `\nCurrent item: ${box.run('show', '1', '--json').out}` : ''));
  // A seat holding its claim gets submit back at once [P7]; the journey reads the queued gate's settled result.
  assert.equal(JSON.parse(submitted.out).queued, true, 'the regenerated source goes through the queued handoff');
  const item = await settledSubmit(box);
  const head = box.git('rev-parse', 'HEAD');
  assert.notEqual(head, original);
  assert.equal(box.git('rev-parse', command === 'remove-shims' ? 'HEAD~2' : 'HEAD^'), currentMain);
  assert.match(readFileSync(join(box.root, 'packages/leaf/src/core/leaf.js'), 'utf8'), /value = 2/u);
  assert.ok(existsSync(marker), 'regeneration runs the full gate even when normal submit defers it');
  assert.ok(item.proofReceipts.some(receipt => receipt.kind === 'submit' && receipt.commit === head && receipt.full === true),
    `the new head has a full-gate receipt: ${JSON.stringify(item.proofReceipts)}`);
  assert.equal(item.queuedSubmit.state, 'green', 'recorded tools use a real queued handoff, not the foreground exemption');
  assert.equal(item.queuedSubmit.commit, head, 'the immutable queue captures the regenerated tool source');
  assert.equal(item.item_status, 'submitted');
  assert.equal(item.item_commit, head);
  assert.equal(item.item_verdict, null);
  assert.equal(item.item_verified_by, null);
  assert.ok(item.proofReceipts.some(receipt => receipt.kind === 'submit' && receipt.commit === head), 'the new head has its own proof');
  assert.ok(!item.proofReceipts.some(receipt => receipt.kind === 'submit' && receipt.commit === original));
  assert.equal(recordedToolCommits(box.root, currentMain, head).at(-1).commands[0].tool, command, 'another main advance can replay this new head too');
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
