/** One transient SSH failure is confirmed, then the healthy runner serves the job, with no quarantine [C7]. Split from lost.test.js for the per-file budget. */
import { executionServicesSource } from '../../tests/fixtures/gate/execution.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { HOST } from '../../tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../tests/fixtures/runner/ssh.js';

/** Build a real private project and a private SSH executable; no configured machine host is contacted. */
function fixture(t, { dropFirst = true } = {}) {
  const e2e = createE2eHelpers(); t.after(e2e.cleanup);
  const box = e2e.project('true');
  const bin = join(box.dir, 'transport-bin'), worker = join(box.dir, 'worker');
  const home = join(box.dir, 'worker-home'), machineHome = join(home, '.pullboard');
  for (const folder of [bin, worker, home, machineHome, box.env.PULLBOARD_MACHINE_HOME]) mkdirSync(folder, { recursive: true });
  const requests = join(box.dir, 'requests.jsonl'), starts = join(box.dir, 'starts.jsonl');
  installSshStandIn({ bin, worker, home, machineHome, requests, starts, dropFirst, nodeCommand: process.execPath });
  const ssh = join(bin, 'ssh');
  writeFileSync(ssh, readFileSync(ssh, 'utf8').replace('record({ dropped: true, stdinBytes,',
    "process.stderr.write('controlled transport disconnection\\n'); record({ dropped: true, stdinBytes,"));
  box.env.PATH = `${bin}:${box.env.PATH}`;
  const runner = { host: `${HOST}-drop`, slots: 1, browser: 0, node: process.execPath };
  writeFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({
    gateSlots: 0, browserSlots: 0, runners: [runner],
    // Live-load ranking probes each runner over SSH before admission, which the holding stand-ins below would stall past the deadline.
    gate: { runnersFirst: true, loadAwareDispatch: false, runnerDispatch: process.env.PULLBOARD_FIXTURE_DISPATCH ?? 'controller' },
  }));
  return { ...box, requests, starts, runner };
}

/** Execute the current implementation inside the fixture's own environment and retain an actionable assertion. */
function child(box, source) {
  // Process-level: a fresh node process proves the module graph loads without the CLI seam.
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', source], {
    cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 90_000,
  });
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('one transient SSH failure is confirmed before a healthy runner is readmitted without quarantine [C7]', t => {
  const box = fixture(t);
  const url = pathToFileURL(join(import.meta.dirname, '../../../../packages/gate/index.js')).href;
  const command = `node -e 'console.log("RECOVERED_EXECUTION")'`;
  const result = child(box, `import {withGateSlot,runProfiledShellAsync} from ${JSON.stringify(url)};
${executionServicesSource(url)}
    import {DatabaseSync} from 'node:sqlite';
    const run=await withGateSlot(process.cwd(),lease=>runProfiledShellAsync(process.cwd(),
      ${JSON.stringify(command)},{gateLease:lease}),{ executionServices,remote:true,onWait(){}});
    const db=new DatabaseSync(process.env.PULLBOARD_MACHINE_HOME+'/resources.sqlite',{readOnly:true});
    const unavailable=db.prepare('SELECT * FROM runner_unavailable').all();
    const failures=db.prepare('SELECT * FROM runner_transport_error').all();db.close();
    console.log(JSON.stringify({green:run.isGreen,output:run.output,unavailable,failures}));`);
  assert.equal(result.green, true);
  assert.equal(result.output.match(/RECOVERED_EXECUTION/gu)?.length, 1);
  assert.deepEqual(result.unavailable, []);
  assert.equal(result.failures.length, 1);
  const diagnostic = JSON.parse(result.failures[0].diagnostic);
  assert.equal(diagnostic.exitCode, 255);
  assert.equal(diagnostic.confirmingProbe.healthy, true);
  const requests = readFileSync(box.requests, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(requests.length, 3, 'failed dispatch, one confirming Node observation, one actual recovered execution');
  assert.equal(requests[0].dropped, true);
});
