/** With gate.overlapStaticProof on, the submit proof starts while the cells step runs, and a red cells step still fails the gate [C7,#9576]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runSubmitGate } from '../../../../../packages/gate/index.js';
import { submitGatePlan } from '../../../../../packages/gate/index.js';
import { executionServices } from '../../../tests/fixtures/gate/execution.js';
import { emptyRepo } from '../../../tests/fixtures/blueprint.js';
import { runFixtureGit } from '../../../tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../tests/fixtures/testkit.js';

const IDENTITY = ['-c', 'user.name=Overlap Test', '-c', 'user.email=overlap@example.test', '-c', 'commit.gpgsign=false'];
/** The cells step: runs 2 s, writes when it ended, and exits with the code it was given. */
const staticScript = (marks, code) => `import { writeFileSync } from 'node:fs';\nsetTimeout(() => { writeFileSync(${JSON.stringify(join(marks, 'static-ended'))}, String(Date.now())); process.exit(${code}); }, 2000);\n`;
/** The proof test: writes when it started, so the test can order it against the cells step. */
const proofScript = marks => `import { writeFileSync } from 'node:fs';\nimport { add } from './add.js';\nif (add(1, 2) !== 3) throw new Error('add');\nwriteFileSync(${JSON.stringify(join(marks, 'proof-started'))}, String(Date.now()));\n`;

/** Commit the given files into a private repository and return the new commit id. */
function commit(root, files) {
  for (const [file, text] of Object.entries(files)) writeFileSync(join(root, file), text);
  runFixtureGit(['add', '-A'], { cwd: root });
  runFixtureGit([...IDENTITY, 'commit', '-q', '-m', 'change'], { cwd: root });
  return runFixtureGit(['rev-parse', 'HEAD'], { cwd: root });
}

/** A two-commit repository whose change selects the timestamp test, under a machine home whose setting is on or off. */
function fixture(t, overlap, staticCode) {
  const box = emptyRepo({ mode: 'inprocess' });
  const root = box.repo;
  const home = box.env.PULLBOARD_MACHINE_HOME;
  mkdirSync(home, { recursive: true });
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous; rmSync(box.dir, { recursive: true, force: true }); });
  fixtureMachineSettings(home, { gateSlots: 2, gate: { overlapStaticProof: overlap, browserFreeChecks: true, localRunner: false } });
  const base = commit(root, { 'package.json': '{"type":"module"}\n', 'static.js': staticScript(home, staticCode), 'add.js': 'export const add = (a, b) => a + b;\n', 'add.test.js': proofScript(home) });
  commit(root, { 'add.js': 'export const add = (a, b) => b + a;\n' });
  const config = { gate: 'true', affectedTests: 'node --test', staticChecks: 'node static.js', submitInvariants: [], registryGuards: [] };
  return { root, base, config, home };
}

/** Run the real gate entry and return when each side finished, in milliseconds. */
async function gate(t, overlap, staticCode) {
  const { root, base, config, home } = fixture(t, overlap, staticCode);
  const plan = submitGatePlan(root, config, { base });
  const run = runSubmitGate(root, config, { base, check: plan.check, executionServices });
  const stamp = name => Number(readFileSync(join(home, name), 'utf8'));
  return { run, stamp, home };
}

test('clause 1: with the setting on, the first proof batch starts before the cells step ends and the gate is green [C7,#9576]', { timeout: 50000 }, async t => {
  const { run, stamp, home } = await gate(t, true, 0);
  const result = await run;
  assert.equal(result.isGreen, true, result.output);
  assert.ok(existsSync(join(home, 'proof-started')), JSON.stringify({ files: result.files, root: result.executionRoot, output: result.output?.slice(-600), proofLog: result.proofLog }));
  assert.ok(stamp('proof-started') < stamp('static-ended'), 'the proof started while the cells step was still running');
});

test('clause 1: with the setting off, the proof starts only after the cells step has ended [C7,#9576]', { timeout: 50000 }, async t => {
  const { run, stamp } = await gate(t, false, 0);
  const result = await run;
  assert.equal(result.isGreen, true, result.output);
  assert.ok(stamp('proof-started') >= stamp('static-ended'), 'the proof waited for the cells step');
});

test('clause 2: with the setting on, a red cells step still refuses GATE_RED and no green proof result returns [C7,#9576]', { timeout: 50000 }, async t => {
  const { run } = await gate(t, true, 1);
  await assert.rejects(run, error => error.code === 'GATE_RED' && /static checks are red/u.test(error.message));
});
