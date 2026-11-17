/** @pullboard-test-input source-cell packages/runners */
/** Only an explicit work-spec version mismatch refreshes the pinned runner tooling once [C7,#2855]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { cellSandbox } from '../../store/tests/fixtures/cell.js';
import { copyPackageFiles } from '../index.js';
import { HOST } from '../../gate/tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../gate/tests/fixtures/runner/ssh.js';
import { runFixtureChildAsync } from '../../gate/tests/fixtures/child.js';

/** Simulate an older worker's pre-execution reply, then let the real pinned capsule execute after refresh. */
function mismatchTransport(box, paths, mode) {
  installSshStandIn(paths);
  const ssh = join(paths.bin, 'ssh');
  const calls = join(box.dir, 'version-calls');
  writeFileSync(calls, '0');
  const original = readFileSync(ssh, 'utf8');
  const injected = `
if (!remoteCommand.includes(' --health ') && !remoteCommand.includes('registration GUI probe')) {
  const file = ${JSON.stringify(calls)};
  const call = Number(readFileSync(file, 'utf8')) + 1;
  writeFileSync(file, String(call));
  if (${mode === 'once' ? 'call === 1' : 'true'}) {
    process.stderr.write('PULLBOARD_RUNNER_SPEC_REFUSED invalid work specification\\n');
    process.stderr.write('PULLBOARD_RUNNER_SPEC_RULE work specification is not an object with version 2\\n');
    ${mode === 'malformed' ? '' : "process.stderr.write('PULLBOARD_RUNNER_SPEC_VERSION 2\\n');"}
    process.exit(1);
  }
}
`;
  const anchor = "const registrationGuiProbe = remoteCommand.includes('/* pullboard registration GUI probe */');";
  assert.ok(original.includes(anchor));
  writeFileSync(ssh, original.replace(anchor, injected + anchor), { mode: 0o700 });
  return calls;
}

test('runners.refresh.a-mismatched-runner-refreshes-once-a: a mismatched runner refreshes once, a second mismatch names both versions, and malformed specs never retry [C7,#2855]', { skip: 'CONTROLLER_ONLY: deleted with #6579' }, async t => {
  const box = cellSandbox(t);
  const project = join(box.dir, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'README.md'), 'Private runner source\n');
  box.git(project, 'init', '-q', '-b', 'main');
  box.git(project, 'add', '.');
  box.git(project, 'commit', '-qm', 'fixture');
  // A committed private copy of the current tooling, so the runner capsule runs from clean committed bytes.
  const tooling = join(box.dir, 'tooling');
  mkdirSync(tooling);
  copyPackageFiles(resolve(import.meta.dirname, '../../..'), tooling);
  box.git(tooling, 'init', '-q', '-b', 'main');
  box.git(tooling, 'add', '.');
  box.git(tooling, 'commit', '-q', '-m', 'test: snapshot current runner tooling');
  const paths = { bin: join(box.dir, 'bin'), worker: join(box.dir, 'worker'), home: join(box.dir, 'worker-home'),
    machineHome: join(box.dir, 'worker-machine'), requests: join(box.dir, 'requests') };
  for (const dir of [paths.bin, paths.worker, paths.home, paths.machineHome]) mkdirSync(dir);
  box.env.PATH = `${paths.bin}:${box.env.PATH}`;
  for (const mode of ['once', 'twice', 'malformed']) {
    const calls = mismatchTransport(box, paths, mode);
    const script = `import assert from 'node:assert/strict';
import {runOnRunnerAsync} from ${JSON.stringify(pathToFileURL(join(tooling, 'packages/runners/index.js')).href)};
const run = () => runOnRunnerAsync(process.cwd(), 'node -e "console.log(45678)"', {runner:{host:${JSON.stringify(HOST)},slots:1,browser:0},metadata:{item:'fixture',kind:'remote-command'}});
${mode === 'once' ? `const result = await run(); assert.equal(result.isGreen, true, JSON.stringify(result)); assert.match(result.output, /45678/u);`
    : `await assert.rejects(run(), error => error.code === 'RUNNER_WORK_SPEC' ${mode === 'twice' ? "&& /controller version 1, runner version 2/u.test(error.message)" : ''});`}
`;
    const result = await runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: project, env: box.env, encoding: 'utf8', timeout: 120_000,
    }); // budget: one real private capsule dispatch and at most one protocol refresh, never a gate wait.
    assert.equal(result.status, 0, result.context);
    assert.equal(Number(readFileSync(calls, 'utf8')), mode === 'malformed' ? 1 : 2, mode);
  }
});
