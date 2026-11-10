/** @pullboard-test-input source-tree */
/** Preserve authenticated source preparation in both public profiling paths before optimizing a measured phase [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { settleReceipt } from '../../../../packages/gate/index.js';
import { startReceipt } from '../../../../packages/gate/index.js';
import { sourcePreparationFields } from '../../../../packages/runners/index.js';
import { writeTimingProfile } from '../../../../packages/gate/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { executionServices } from '../../tests/fixtures/gate/execution.js';
import { executionServicesSource } from '../../tests/fixtures/gate/execution.js';
import { cleanupFixtureChildren } from '../../tests/fixtures/child.js';
import { runFixtureChildAsync } from '../../tests/fixtures/child.js';
import { HOST } from '../../tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../tests/fixtures/runner/ssh.js';
import { awaitRoundTrip } from '../../tests/fixtures/runner/tooling.js';
import { cleanupToolingSnapshots } from '../../tests/fixtures/runner/tooling.js';
import { committedToolingSnapshot } from '../../tests/fixtures/runner/tooling.js';
import { phaseCounts } from '../../tests/fixtures/runner/tooling.js';

const helpers = createE2eHelpers();
after(cleanupFixtureChildren);
after(cleanupToolingSnapshots);
after(helpers.cleanup);

test('sync and async admitted runner profiles retain the actual worker source phases and receipts [C7]', async () => {
  const box = helpers.sandbox();
  const paths = Object.fromEntries(['repo', 'worker', 'ssh-bin', 'remote-home', 'remote-machine'].map(name => [name, join(box.dir, name)]));
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  box.git(paths.repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(paths.repo, 'pullboard.json'), '{"gate":"true"}\n');
  writeFileSync(join(paths.repo, 'source.txt'), 'A committed source input.\n');
  box.git(paths.repo, 'add', '-A');
  box.git(paths.repo, 'commit', '-qm', 'test: source preparation observation fixture');
  const head = box.git(paths.repo, 'rev-parse', 'HEAD');
  const requests = join(box.dir, 'requests.jsonl'), stderrLog = join(box.dir, 'worker.stderr');
  installSshStandIn({ bin: paths['ssh-bin'], worker: paths.worker, home: paths['remote-home'],
    machineHome: paths['remote-machine'], requests, stderrLog });
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  writeFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({ gateSlots: 1,
    browserSlots: 0, runners: [{ host: HOST, slots: 1, browser: 0 }],
    gate: { runnersOnly: true, memoryFloorMB: 0 } }));
  const gateUrl = pathToFileURL(join(committedToolingSnapshot(join(import.meta.dirname, '../../../..'), box.env), 'packages/gate/index.js')).href;
  const command = `node -e "console.log('SOURCE_PREPARATION_CAPTURED')"`;
  for (const mode of ['sync', 'async']) {
    const driver = `import {readFileSync} from 'node:fs';
import {runProfiledShell,runProfiledShellAsync,withGateSlot} from ${JSON.stringify(gateUrl)};
${executionServicesSource(gateUrl)}
let observedReceipt;
const result=await withGateSlot(process.cwd(),lease=>${mode === 'sync' ? 'runProfiledShell' : 'runProfiledShellAsync'}(process.cwd(),
  ${JSON.stringify(command)},{gateLease:lease}),
  {executionServices,runnerOnly:true,browser:false,agent:'source-preparation-fixture',kind:'test',onReceipt:receipt=>{observedReceipt=receipt;}});
console.log(JSON.stringify({green:result.isGreen,output:result.output,runner:result.executionRunner,
  source:result.executionSource,observed:result.sourcePreparation,profile:result.profile.sourcePreparation,
  saved:JSON.parse(readFileSync(result.profilePath,'utf8')).sourcePreparation,
  profileReceipt:result.profile.receipt.sourcePreparation,receipt:observedReceipt.sourcePreparation}));`;
    const phases = requests + '.phases', before = phaseCounts(phases);
    const closed = runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', driver], {
      cwd: paths.repo, env: { ...box.env, PATH: paths['ssh-bin'] + ':' + box.env.PATH }, detached: true,
    });
    const child = await awaitRoundTrip(closed.child, closed, phases, before);
    assert.equal(child.status, 0, `${child.context}\n${child.stdout}`);
    const result = JSON.parse(child.stdout.trim().split('\n').at(-1));
    assert.equal(result.green, true, result.output);
    assert.equal(result.runner, HOST);
    assert.equal(result.source.commit, head);
    assert.match(result.output, /SOURCE_PREPARATION_CAPTURED/u);
    const worker = readFileSync(stderrLog, 'utf8').split(/\r?\n/u).filter(line => line.startsWith('PULLBOARD_RUNNER_RESULT ')).at(-1);
    const receipt = JSON.parse(Buffer.from(worker.split(' ')[2], 'base64').toString('utf8'));
    const expected = sourcePreparationFields(receipt.sourcePreparation);
    assert.ok(expected, 'the nonce-bound worker produced the complete existing source measurement');
    for (const key of ['observed', 'profile', 'saved', 'profileReceipt', 'receipt']) {
      assert.deepEqual(result[key], expected, `${mode} ${key} retains the actual worker observation`);
    }
  }
});

test('receipt projection leaves absent and malformed old-worker source observations unknown [C7]', () => {
  const box = helpers.sandbox();
  // A projection-only synthetic lease: it claims no command, native proof or measured source preparation.
  const lease = { tracker: startReceipt(), receiptKind: 'fixture', slot: { kind: 'runner' },
    runner: { host: 'fixture-unmeasured', slots: 1, browser: 0 }, executionServices };
  for (const value of [undefined, null, {}, { version: 1, totalMs: 0 }]) {
    lease.sourcePreparation = value;
    assert.equal(Object.hasOwn(settleReceipt(lease), 'sourcePreparation'), false,
      'missing measurements never become a fabricated zero or an unchecked receipt object');
    assert.equal(Object.hasOwn(writeTimingProfile(join(box.dir, 'unknown.profile.json'), { sourcePreparation: value }), 'sourcePreparation'), false,
      'the persisted profile also leaves absent or invalid worker measurements unknown');
  }
});
