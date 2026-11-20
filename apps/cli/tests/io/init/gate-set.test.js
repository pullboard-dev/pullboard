/** Setting the gate with one pullboard command, the NO_GATE next step and gate set's placement [I1,A1,C3,L3,B26]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { runPrinted } from '../../fixtures/init-printed.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('cli.journeys-init-gate-set.the-gate-is-set-with-one: the gate is set with one pullboard command [I1,A1,B26]', async () => {
  const box = e2e.sandbox();
  const root = join(box.dir, 'one-gate-command');
  mkdirSync(root);
  box.git(root, 'init', '-q', '-b', 'main');
  const initialized = await box.runLocal(root, 'init');
  assert.equal(initialized.code, 0, initialized.err || initialized.out);

  const configFile = join(root, 'pullboard.json');
  const initial = JSON.parse(readFileSync(configFile, 'utf8'));
  initial.gate = '';
  initial.lanes.checks = { owns: ['checks/'] };
  initial.fixtureSetting = { kept: ['spaces and "quotes"', { nested: true }] };
  writeFileSync(configFile, JSON.stringify(initial, null, 2) + '\n');
  writeFileSync(join(root, 'SPEC.md'), "# Gate project\n\n## G \u00b7 Goals\n- G1 [approved, must] The project gate checks the work. | gate: test\n");
  mkdirSync(join(root, 'checks'));
  const marker = join(box.dir, 'chosen gate ran.json');
  const checker = join(root, 'checks', 'project check.mjs');
  writeFileSync(checker, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\n`);
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', 'chore: prepare a board without a gate');

  const resumed = await box.runLocal(root, 'resume', '--diagnostics', '--json');
  assert.equal(resumed.code, 0, resumed.err || resumed.out);
  assert.equal(JSON.parse(resumed.out).setup.step, 3);
  const step = JSON.parse(resumed.out).setup.steps.find(entry => entry.number === 3);
  assert.equal(step.done, false);
  assert.match(step.command, /^pullboard gate set /u);
  assert.doesNotMatch(step.command, /node -e|writeFileSync/u);
  const resumedText = await box.runLocal(root, 'resume', '--diagnostics');
  assert.equal(resumedText.code, 0, resumedText.err || resumedText.out);
  assert.ok(resumedText.out.includes(step.command));
  assert.doesNotMatch(resumedText.out, /node -e.*pullboard\.json/u);
  const missing = await box.runLocal(root, 'gate', '--json');
  assert.equal(missing.code, 1, missing.err || missing.out);
  const refusal = JSON.parse(missing.out).error;
  assert.equal(refusal.code, 'NO_GATE');
  assert.match(refusal.next, /pullboard gate set/u);
  assert.doesNotMatch(refusal.next, /node -e/u);

  /** Quote each shell word while retaining the entire configured command as one CLI argument. */
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const argument = `proof with spaces, "double quotes" and 'single quotes'`;
  const command = [process.execPath, checker, argument].map(quote).join(' ');
  const before = JSON.parse(readFileSync(configFile, 'utf8'));
  const configured = await box.runLocal(root, 'gate', 'set', command, '--json');
  assert.equal(configured.code, 0, configured.err || configured.out);
  assert.equal(JSON.parse(configured.out).gate, command);
  assert.deepEqual(JSON.parse(readFileSync(configFile, 'utf8')), { ...before, gate: command });
  assert.equal(existsSync(marker), false, 'setting the command neither executes it nor stamps it green');
  const answered = await box.runLocal(root, 'resume', '--diagnostics', '--json');
  assert.equal(answered.code, 0, answered.err || answered.out);
  assert.equal(JSON.parse(answered.out).setup.steps.find(entry => entry.number === 3).done, true);

  // The normal gate trusts committed coordinator policy, so commit the chosen answer first.
  box.git(root, 'add', 'pullboard.json');
  box.git(root, 'commit', '-q', '-m', 'chore: choose the project gate');
  const gated = await box.runLocal(root, 'gate', '--json');
  assert.equal(gated.code, 0, gated.err || gated.out);
  assert.equal(JSON.parse(gated.out).green, true);
  assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), [argument]);
});

test('cli.journeys-init-gate-set.no-gate-names-the-project-test: NO_GATE names the project test before a spec-only fallback [I1,C3,B26]', async () => {
  const box = e2e.sandbox();
  const root = join(box.dir, 'red-make-project');
  mkdirSync(root);
  box.git(root, 'init', '-q', '-b', 'main');
  const initialized = await box.runLocal(root, 'init');
  assert.equal(initialized.code, 0, initialized.err || initialized.out);
  const marker = join(box.dir, 'make-test-ran');
  const quotedMarker = `'${marker.replaceAll("'", "'\\''")}'`;
  writeFileSync(join(root, 'Makefile'), `test:\n\t@printf tested > ${quotedMarker}\n\t@exit 1\n`);
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', 'chore: prepare a project with a failing test');

  const missing = await box.runLocal(root, 'gate', '--json');
  assert.equal(missing.code, 1, missing.err || missing.out);
  const refusal = JSON.parse(missing.out).error;
  assert.equal(refusal.code, 'NO_GATE');
  const suggested = /pullboard gate set '[^']*'/u.exec(refusal.next)?.[0];
  assert.equal(suggested, "pullboard gate set 'make test'", 'the next step keeps the actual project test');
  assert.doesNotMatch(refusal.next, /pullboard spec check/u, 'a known test command is not replaced with a spec check');
  assert.equal(existsSync(marker), false, 'finding a test command never executes it');
  const configured = await runPrinted(box, root, suggested);
  assert.equal(configured.status, 0, configured.failure || configured.stderr || configured.stdout);
  assert.equal(JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8')).gate, 'make test');
  assert.equal(existsSync(marker), false, 'the printed setter does not execute the test');
  box.git(root, 'add', 'pullboard.json');
  box.git(root, 'commit', '-q', '-m', 'chore: record the printed project gate');
  const gated = await box.runLocal(root, 'gate', '--json');
  assert.equal(gated.code, 1, gated.err || gated.out);
  assert.equal(JSON.parse(gated.out).green, false, 'following the advice cannot certify red project tests');
  assert.equal(readFileSync(marker, 'utf8'), 'tested', 'the real Makefile target ran');
});

test('cli.journeys-init-gate-set.gate-set-keeps-configuration-in-the: gate set keeps configuration in the coordinator checkout [I1,L3,B26]', async () => {
  const box = e2e.project();
  const mainFile = join(box.repo, 'pullboard.json');
  const laneFile = join(box.web, 'pullboard.json');
  const mainBefore = readFileSync(mainFile, 'utf8');
  const laneBefore = readFileSync(laneFile, 'utf8');
  const forbidden = await box.runLocal(box.web, 'gate', 'set', 'echo changed', '--json');
  assert.equal(forbidden.code, 1, forbidden.err || forbidden.out);
  const refusal = JSON.parse(forbidden.out).error;
  assert.equal(refusal.code, 'NOT_MAIN');
  assert.match(refusal.next, /ask the coordinator.*pullboard gate set/u);
  assert.equal(readFileSync(mainFile, 'utf8'), mainBefore);
  assert.equal(readFileSync(laneFile, 'utf8'), laneBefore);

  for (const args of [[], [''], ['   '], ['echo', 'split'], ['echo ok', '--landing']]) {
    const invalid = await box.runLocal(box.repo, 'gate', 'set', ...args, '--json');
    assert.equal(invalid.code, 1, invalid.err || invalid.out);
    assert.equal(JSON.parse(invalid.out).error.code, 'USAGE');
    assert.match(JSON.parse(invalid.out).error.next, /pullboard gate set/u);
    assert.equal(readFileSync(mainFile, 'utf8'), mainBefore, 'a malformed setter leaves all configuration alone');
  }
});

