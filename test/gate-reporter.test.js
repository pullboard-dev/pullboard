/** Landing retains the first real assertion identity when abort interrupts a reporter [C7,V4]. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { copyPackageFiles } from '../packages/runners/index.js';
import { gateSlotEnvironment, inheritedGateSlot, takeResource } from '../packages/resources/index.js';
import { gateRunnerAdmission } from '../packages/config/index.js';
import { runFixtureChild } from './fixture-child.js';

const ROOT = resolve(import.meta.dirname, '..');

test('an aborted landing publishes the first failing file and test as a structured outcome [C7,V4]', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-gate-reporter-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const machineHome = join(root, 'machine');
  mkdirSync(machineHome);
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  copyPackageFiles(ROOT, root);
  /** Add temporary stage markers to the private runner copy to locate the unresolved await. */
  function instrument(relativePath, edits) {
    const path = join(root, relativePath);
    let source = readFileSync(path, 'utf8');
    for (const [before, after] of edits) {
      assert.ok(source.includes(before), `diagnostic anchor exists in ${relativePath}: ${before.slice(0, 48)}`);
      source = source.replace(before, after);
    }
    writeFileSync(path, source);
  }
  instrument('bin/run-tests.js', [
    ["  const result = await executeTests(actions.args, sandbox, gateMarkers, fullSuite && !actions.files, concurrency, timing);",
      "  process.stderr.write('TRACE run-tests: before executeTests\\n');\n  const result = await executeTests(actions.args, sandbox, gateMarkers, fullSuite && !actions.files, concurrency, timing);\n  process.stderr.write('TRACE run-tests: after executeTests\\n');"],
    ["  const result = process.env[LANDING_RUN_ENV] === '1'\n    ? await runLandingTests(selectedArgs, env, concurrency, fullSuite && patterns.length === 0)",
      "  process.stderr.write('TRACE run-tests: before execution branch\\n');\n  const result = process.env[LANDING_RUN_ENV] === '1'\n    ? await runLandingTests(selectedArgs, env, concurrency, fullSuite && patterns.length === 0)"],
    ["    await abortPromise;\n    await Promise.all(reporterEnds);",
      "    process.stderr.write('TRACE landing: before abortPromise\\n');\n    await abortPromise;\n    process.stderr.write('TRACE landing: after abortPromise, reporterEnds=' + reporterEnds.length + '\\n');\n    await Promise.all(reporterEnds);\n    process.stderr.write('TRACE landing: reporters ended\\n');"],
    ["    stream.on('end', endReporters);", "    stream.on('end', () => { process.stderr.write('TRACE landing: stream ended\\n'); endReporters(); });"],
  ]);
  instrument('packages/gate/src/shell/test-file-dispatch.js', [
    ["  const files = options.selectedFiles ?? options.files ?? [];", "  const files = options.selectedFiles ?? options.files ?? [];\n  process.stderr.write('TRACE dispatch: files=' + files.length + '\\n');"],
    ["      browser = await browserLease(file);", "      process.stderr.write('TRACE fileRun: start\\n');\n      browser = await browserLease(file);\n      process.stderr.write('TRACE fileRun: browser acquired\\n');"],
    ["      unlock = await acquire();", "      unlock = await acquire();\n      process.stderr.write('TRACE fileRun: queue acquired\\n');"],
    ["      token = await reserveTestFileToken(env, signal);", "      token = await reserveTestFileToken(env, signal);\n      process.stderr.write('TRACE fileRun: token reserved\\n');"],
    ["      const events = [];", "      process.stderr.write('TRACE fileRun: source created\\n');\n      const events = [];"],
    ["        for await (const event of source) {", "        process.stderr.write('TRACE drain: started\\n');\n        for await (const event of source) {\n          process.stderr.write('TRACE drain event: ' + event.type + '\\n');"],
    ["        const actualWorkers = await fileExited();", "        process.stderr.write('TRACE drain: stream ended\\n');\n        const actualWorkers = await fileExited();\n        process.stderr.write('TRACE drain: fileExited resolved ' + actualWorkers + '\\n');"],
    ["      const completed = drained.finally(async () => { await fileExited(); await token.drained(); token.release(); });", "      const completed = drained.finally(async () => { process.stderr.write('TRACE completed: cleanup start\\n'); await fileExited(); process.stderr.write('TRACE completed: worker exited\\n'); await token.drained(); process.stderr.write('TRACE completed: token drained\\n'); token.release(); process.stderr.write('TRACE completed: token released\\n'); });"],
    ["      await Promise.race([token.transferred(), completed]);", "      await Promise.race([token.transferred().then(() => { process.stderr.write('TRACE race: transferred\\n'); }), completed.then(() => { process.stderr.write('TRACE race: completed\\n'); })]);\n      process.stderr.write('TRACE fileRun: race settled\\n');"],
    ["      await completed;", "      process.stderr.write('TRACE fileRun: before completed await\\n');\n      await completed;\n      process.stderr.write('TRACE fileRun: completed await returned\\n');"],
    ["      for await (const event of source) for (const input of inputs) input.write(event);", "      for await (const event of source) { process.stderr.write('TRACE dispatch: ' + event.type + '\\n'); for (const input of inputs) input.write(event); }\n      process.stderr.write('TRACE dispatch: stream ended\\n');"],
    ["      const outcomes = await Promise.allSettled(work);", "      process.stderr.write('TRACE finish: waiting lanes\\n');\n      const outcomes = await Promise.allSettled(work);\n      process.stderr.write('TRACE finish: lanes settled\\n');"],
    ["    await Promise.all(ends);", "    process.stderr.write('TRACE dispatch: waiting reporters\\n');\n    await Promise.all(ends);\n    process.stderr.write('TRACE dispatch: reporters ended\\n');"],
  ]);
  instrument('packages/gate/src/shell/test-file-pool.js', [
    ["    const owned = () => db.prepare('SELECT pid FROM file_holder WHERE dispatch = ?').get(nonce);", "    const owned = () => db.prepare('SELECT pid, lender, call, dispatch, path FROM file_holder WHERE dispatch = ?').get(nonce);"],
    ["      async drained() {\n        while (!closed) {\n          const holder = owned();", "      async drained() {\n        let previousState = null;\n        while (!closed) {\n          const holder = owned();\n          const state = JSON.stringify({ holder, alive: holder ? alive(holder.pid) : false, process: process.pid, poolLender: pool.lender ?? null, poolCall: pool.call ?? null, nonce });\n          if (state !== previousState) { process.stderr.write('TRACE token drain state: ' + state + '\\n'); previousState = state; }"],
    ["  if (dispatched) {\n    if (!Number.isSafeInteger(dispatched.parent)", "  if (dispatched) {\n    process.stderr.write('TRACE token worker: process=' + process.pid + ' ppid=' + process.ppid + ' pool=' + JSON.stringify(pool) + '\\n');\n    if (!Number.isSafeInteger(dispatched.parent)"],
    ["  process.once('exit', () => {\n    try {\n      // The dispatcher's row stays charged through every exit listener until the actual process has exited.", "  process.once('exit', () => {\n    process.stderr.write('TRACE token worker exit: process=' + process.pid + ' pool=' + JSON.stringify(pool) + '\\n');\n    try {\n      // The dispatcher's row stays charged through every exit listener until the actual process has exited."],
    ["      release() {\n        if (closed) return;", "      release() {\n        process.stderr.write('TRACE token release: enter closed=' + closed + ' owned=' + JSON.stringify(owned()) + '\\n');\n        if (closed) return;"],
    ["        db.prepare('DELETE FROM file_holder WHERE dispatch = ?').run(nonce);\n        db.close();\n        closed = true;", "        const removed = db.prepare('DELETE FROM file_holder WHERE dispatch = ?').run(nonce).changes;\n        process.stderr.write('TRACE token release: deleted=' + removed + '\\n');\n        db.close();\n        closed = true;\n        process.stderr.write('TRACE token release: closed\\n');"],
  ]);
  const activityMarker = join(root, 'fixture-activity');
  writeFileSync(join(root, 'test', 'spec-failure.test.js'), `import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
writeFileSync(${JSON.stringify(activityMarker)}, 'loaded');
test('spec default failure [C7]', () => assert.fail('intentional reporter fixture failure'));
`);
  const priorMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = machineHome;
  let lease;
  try { lease = await takeResource({ name: 'gate', capacity: 1, root, agent: 'gate-reporter-fixture' }); }
  finally {
    if (priorMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = priorMachineHome;
  }
  t.after(() => {
    const currentMachineHome = process.env.PULLBOARD_MACHINE_HOME;
    process.env.PULLBOARD_MACHINE_HOME = machineHome;
    try { lease.release(); }
    finally {
      if (currentMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
      else process.env.PULLBOARD_MACHINE_HOME = currentMachineHome;
    }
  });
  const env = { ...process.env, ...gateSlotEnvironment(lease), PULLBOARD_MACHINE_HOME: machineHome, PULLBOARD_LANDING_RUN: '1' };
  const admissionKeys = ['PULLBOARD_MACHINE_HOME', 'PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD'];
  const previousAdmission = new Map(admissionKeys.map(key => [key, process.env[key]]));
  let inherited, runnerOnly;
  try {
    for (const key of admissionKeys) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    inherited = inheritedGateSlot({ root, namedFiles: false });
    runnerOnly = gateRunnerAdmission().runnerOnly === true;
  } finally {
    for (const [key, value] of previousAdmission) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.ok(inherited, 'fixture child has the exact live gate lease for its private machine home');
  assert.equal(inherited.runnerExecution, false, 'fixture lease is local and does not claim a runner execution');
  assert.equal(runnerOnly, false, 'fixture machine does not require a registered runner');
  for (const key of ['NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'PULLBOARD_RUNNER_PRELOAD', 'PULLBOARD_RUNNER_JOB', 'PULLBOARD_RUNNER_INSTANCE', 'PULLBOARD_RELEASE_EXECUTORS']) delete env[key];
  const result = runFixtureChild(process.execPath, [join(root, 'bin', 'run-tests.js'), '--test-reporter=spec', 'test/spec-failure.test.js'],
    { cwd: root, env, encoding: 'utf8', timeout: 60000 });
  const output = `fixture loaded=${existsSync(activityMarker)}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.equal(result.status, 1, `${result.context}\n${output}`);
  const frame = output.split('\n').find(line => line.startsWith('# pullboard test outcomes '));
  assert.ok(frame, 'the failure remains accounted after landing abort');
  assert.deepEqual(JSON.parse(frame.slice('# pullboard test outcomes '.length)).tests,
    [{ file: 'test/spec-failure.test.js', name: 'spec default failure [C7]', passed: false, skipped: false }]);
});
