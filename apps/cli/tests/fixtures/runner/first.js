/** @pullboard-module-loads packages/gate/index.js packages/runners/index.js */
/** Exercise runner-first placement, zero local pools, and public submit/landing gate paths [C7]. */
import { executionServices } from '../gate/execution.js';
import { executionServicesSource } from '../gate/execution.js';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { runFixtureChild } from '../child.js';
import {
  HOST,
  installRegistrationProbeStandIn,
  installSshStandIn,
} from './ssh.js';
import { fixtureAdd } from '../testkit.js';

/** Ask the real private machine queue for one gate lease from a fresh process. */
function runPrivateGateLease(box, behavior = '') {
  const gateUrl = pathToFileURL(resolve(import.meta.dirname, '../../../../../packages/gate/index.js')).href;
  const runnersUrl = pathToFileURL(resolve(import.meta.dirname, '../../../../../packages/runners/index.js')).href;
  const source = `import { withGateSlot } from ${JSON.stringify(gateUrl)};
${executionServicesSource(gateUrl)}
import { RunnerDropped } from ${JSON.stringify(runnersUrl)};
const root = ${JSON.stringify(box.repo)};
let remoteAttempts = 0;
const result = await withGateSlot(root, async lease => {
  ${behavior}
  return lease.runner?.host ?? 'local';
}, { executionServices, remote: true, kind: 'runner-first-cursor-test' });
process.stdout.write(result + '\\n');
`;
  return runFixtureChild(process.execPath, ['--input-type=module', '-e', source], { cwd: box.repo, env: box.env, encoding: 'utf8' });
}

/** Run the complete frozen runner-first policy scenario, including public submit and landing gate. */
export async function runnerFirstPolicyCase(e2e) {
  const box = e2e.privateCheckSubmission({ check: 'true' });
  const settingsFile = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  const probeBin = join(box.dir, 'registration-bin');
  mkdirSync(probeBin);
  installRegistrationProbeStandIn({ bin: probeBin });
  box.env.PATH = `${probeBin}:${box.env.PATH}`;
  // This case proves durable rotation, independently of the live-load ranking policy.
  const rotation = box.run(box.repo, 'settings', 'gate.loadAwareDispatch', 'off');
  assert.equal(rotation.code, 0, rotation.err);
  const hosts = ['a51', 'a52', 'a53'];
  for (const host of hosts) {
    const added = box.run(box.repo, 'runner', 'add', host, '--slots', '1', '--browser', '1');
    assert.equal(added.code, 0, `${host} is registered: ${added.err}`);
  }
  // With two or more runners the first is kept for timed checks by default; rotation needs every runner open to ordinary runs.
  const keptSettings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  writeFileSync(settingsFile, JSON.stringify({ ...keptSettings, gate: { ...keptSettings.gate, timingRunner: false, runnerDispatch: 'controller' } }));
  const first = box.run(box.repo, 'settings', 'gate.runnersFirst', 'on');
  assert.equal(first.code, 0, first.err);
  const browserZero = box.run(box.repo, 'settings', 'browserSlots', '0');
  assert.equal(browserZero.code, 0, `registered runners allow browserSlots 0: ${browserZero.err}`);
  const gateZero = box.run(box.repo, 'settings', 'gateSlots', '0');
  assert.equal(gateZero.code, 0, `registered runners allow gateSlots 0: ${gateZero.err}`);
  const effective = JSON.parse(box.run(box.repo, 'settings', '--json').out).settings;
  assert.equal(effective.gate.runnersFirst, true);
  assert.equal(effective.gateSlots, 0);
  assert.equal(effective.browserSlots, 0);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(() => {
    const result = runPrivateGateLease(box);
    assert.equal(result.status, 0, result.context);
    return result.stdout.trim();
  }), ['a51', 'a52', 'a53', 'a51', 'a52', 'a53'], 'the durable cursor rotates across fresh process requests');

  const priorHome = process.env.PULLBOARD_HOME;
  const priorMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_HOME = box.env.PULLBOARD_HOME;
  process.env.PULLBOARD_MACHINE_HOME = box.env.PULLBOARD_MACHINE_HOME;
  let releaseHeld;
  let heldRun;
  try {
    const { withGateSlot } = await import(pathToFileURL(resolve(import.meta.dirname, '../../../../../packages/gate/index.js')).href);
    let announce;
    const admitted = new Promise(resolvePromise => { announce = resolvePromise; });
    heldRun = withGateSlot(box.repo, async lease => {
      announce(lease.runner?.host ?? 'local');
      await new Promise(resolvePromise => { releaseHeld = resolvePromise; });
      return lease.runner?.host ?? 'local';
    }, { executionServices, remote: true, agent: 'runner-first-full-control', kind: 'runner-first-cursor-test' });
    assert.equal(await admitted, 'a51', 'the first live runner lease occupies the next runner');
    assert.deepEqual([runPrivateGateLease(box), runPrivateGateLease(box)].map(result => {
      assert.equal(result.status, 0, result.context);
      return result.stdout.trim();
    }), ['a52', 'a53'], 'the cursor advances past the occupied host before returning to it');
    const skipped = runPrivateGateLease(box);
    assert.equal(skipped.status, 0, skipped.context);
    assert.equal(skipped.stdout.trim(), 'a52', 'a full next runner is skipped');
  } finally {
    releaseHeld?.();
    if (heldRun) await heldRun;
    if (priorHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = priorHome;
    if (priorMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = priorMachineHome;
  }

  const unreachable = runPrivateGateLease(box, `if (lease.runner?.host === 'a53') throw new RunnerDropped('a53');`);
  assert.equal(unreachable.status, 0, unreachable.context);
  assert.equal(unreachable.stdout.trim(), 'a51', 'an unreachable next runner is marked unavailable and skipped on its original queue request');

  const fallbackCapacity = box.run(box.repo, 'settings', 'gateSlots', '1');
  assert.equal(fallbackCapacity.code, 0, fallbackCapacity.err);
  const fallbackBrowser = box.run(box.repo, 'settings', 'browserSlots', '1');
  assert.equal(fallbackBrowser.code, 0, fallbackBrowser.err);
  // Every registered runner refuses once; with none reserved for timed checks that is one drop per host.
  const fallback = runPrivateGateLease(box, `if (lease.runner && remoteAttempts++ < ${hosts.length}) throw new RunnerDropped(lease.runner.host);`);
  assert.equal(fallback.status, 0, fallback.context);
  assert.equal(fallback.stdout.trim(), 'local', 'after registered runners refuse, runner-first uses the available local slot');

  const noRunner = e2e.privateCheckSubmission({ check: 'true' });
  const refusedGate = noRunner.run(noRunner.repo, 'settings', 'gateSlots', '0');
  process.stderr.write('MARK 1\n');
  assert.notEqual(refusedGate.code, 0);
  process.stderr.write('MARK 2\n');
  assert.match(refusedGate.err, /BAD_GATE_SLOTS/u);
  process.stderr.write('MARK 3\n');
  assert.match(refusedGate.err, /registered runner/u);
  process.stderr.write('MARK 4\n');
  const refusedBrowser = noRunner.run(noRunner.repo, 'settings', 'browserSlots', '0');
  process.stderr.write('MARK 5\n');
  assert.notEqual(refusedBrowser.code, 0);
  process.stderr.write('MARK 6\n');
  assert.match(refusedBrowser.err, /BAD_BROWSER_SLOTS/u);
  process.stderr.write('MARK 7\n');
  assert.match(refusedBrowser.err, /registered runner/u);
  process.stderr.write('MARK 8\n');
  assert.ok(readFileSync(settingsFile, 'utf8').includes('runnersFirst'), 'the opted-in policy is persisted only in the private fixture');
  process.stderr.write('MARK 9\n');

  // Public submit and landing-gate entry exercise the real worker transport. This does not claim
  // the coordinator-only `pullboard land` orchestration itself ran here.
  const integrated = e2e.project('true');
  process.stderr.write('MARK 10\n');
  const runner = HOST;
  process.stderr.write('MARK 11\n');
  const runnerBin = join(integrated.dir, 'submit-land-bin');
  process.stderr.write('MARK 12\n');
  const worker = join(integrated.dir, 'submit-land-worker');
  process.stderr.write('MARK 13\n');
  const remoteHome = join(integrated.dir, 'submit-land-home');
  process.stderr.write('MARK 14\n');
  const remoteMachineHome = join(remoteHome, '.pullboard');
  process.stderr.write('MARK 15\n');
  const requests = join(integrated.dir, 'submit-land-ssh-requests.jsonl');
  process.stderr.write('MARK 16\n');
  for (const folder of [runnerBin, worker, remoteHome, remoteMachineHome]) mkdirSync(folder, { recursive: true });
  process.stderr.write('MARK 17\n');
  integrated.env.PATH = `${runnerBin}:${integrated.env.PATH}`;
  process.stderr.write('MARK 18\n');
  installSshStandIn({ bin: runnerBin, worker, home: remoteHome, machineHome: remoteMachineHome, requests });
  process.stderr.write('MARK 19\n');
  // Filed before any runner exists, and waited for: with one registered the add's baseline run would be a fourth request.
  const added = fixtureAdd(integrated.run, integrated.repo, 'web', 'Runner-first public submit', '--specs', 'G1',
    '--criterion', 'the runner executes the submitted gate', '--check', `${process.execPath} -e "setTimeout(() => {}, 1000)"`, '--wait', '--json');
  assert.equal(added.code, 0, added.err);
  process.stderr.write('MARK 20\n');
  const id = JSON.parse(added.out).item.item_id;
  process.stderr.write('MARK 21\n');
  const registered = integrated.run(integrated.repo, 'runner', 'add', runner, '--slots', '1', '--browser', '1');
  process.stderr.write('MARK 22\n');
  assert.equal(registered.code, 0, registered.err);
  process.stderr.write('MARK 23\n');
  for (const [key, value] of [['gate.runnersFirst', 'on'], ['browserSlots', '0'], ['gateSlots', '0']]) {
    const setting = integrated.run(integrated.repo, 'settings', key, value);
    assert.equal(setting.code, 0, `${key} ${value}: ${setting.err}`);
  }
  // The settings writes above must not leave the submitting process waiting on a pull runner; pin controller dispatch again [P7].
  const integratedSettings = join(integrated.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  process.stderr.write('MARK 24\n');
  const integratedKept = JSON.parse(readFileSync(integratedSettings, 'utf8'));
  process.stderr.write('MARK 25\n');
  writeFileSync(integratedSettings, JSON.stringify({ ...integratedKept, gate: { ...integratedKept.gate, runnerDispatch: 'controller' } }));
  process.stderr.write('MARK 26\n');
  assert.equal(integrated.run(integrated.web, 'claim', String(id)).code, 0);
  process.stderr.write('MARK 27\n');
  const built = e2e.commitFile(integrated, integrated.web, 'web/runner-first.txt', 'submitted on runner\n', 'feat(web): add runner-first fixture [G1]');
  process.stderr.write('MARK 28\n');
  assert.equal(built.status, 0, built.stderr);
  process.stderr.write('MARK 29\n');
  const submittedCommit = integrated.git(integrated.web, 'rev-parse', 'HEAD');
  process.stderr.write('MARK 30\n');
  const submitted = integrated.run(integrated.web, 'submit', String(id), '--json');
  process.stderr.write('MARK 31\n');
  assert.equal(submitted.code, 0, `${submitted.out}\n${submitted.err}`);
  process.stderr.write('MARK 32\n');
  const submittedDocument = JSON.parse(submitted.out);
  process.stderr.write('MARK 33\n');
  const submitGateProfile = JSON.parse(readFileSync(submittedDocument.gate.check.profilePath, 'utf8'));
  process.stderr.write('MARK 34\n');
  const submitProofProfile = JSON.parse(readFileSync(submittedDocument.gate.proofProfilePath, 'utf8'));
  process.stderr.write('MARK 35\n');
  assert.equal(submitGateProfile.executionRunner, runner, 'public submit executes on the registered runner');
  process.stderr.write('MARK 36\n');
  assert.equal(submitGateProfile.executionSource?.commit, submittedCommit, 'the worker receipt binds the submitted check');
  process.stderr.write('MARK 37\n');
  assert.equal(submitGateProfile.receipt?.runner?.id, runner, 'the submit check records the actual runner admission receipt');
  process.stderr.write('MARK 38\n');
  assert.equal(submitProofProfile.executionSource?.commit, submittedCommit, 'the worker receipt binds the submitted proof');
  process.stderr.write('MARK 39\n');
  assert.equal(submitProofProfile.receipt?.runner?.id, runner, 'the submit proof records the actual runner admission receipt');
  process.stderr.write('MARK 40\n');

  const submitRequests = readFileSync(requests, 'utf8').trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
  process.stderr.write('MARK 41\n');
  assert.equal(submitRequests.length, 3, 'remote cell analysis, criterion and proof each make one actual SSH worker request');
  process.stderr.write('MARK 42\n');

  const landingGate = integrated.run(integrated.repo, 'gate', '--landing', '--json');
  process.stderr.write('MARK 43\n');
  assert.equal(landingGate.code, 0, `${landingGate.out}\n${landingGate.err}`);
  process.stderr.write('MARK 44\n');
  const landingProfile = JSON.parse(readFileSync(join(integrated.repo, '.git', 'pullboard-gate.log.profile.json'), 'utf8'));
  process.stderr.write('MARK 45\n');
  assert.equal(landingProfile.executionRunner, runner, 'the public landing gate uses the registered runner');
  process.stderr.write('MARK 46\n');
  assert.equal(landingProfile.executionSource?.commit, integrated.git(integrated.repo, 'rev-parse', 'HEAD'),
    'the landing-gate worker receipt binds the exact main source it checked');
  assert.equal(landingProfile.receipt?.runner?.id, runner, 'the landing gate records the actual runner admission receipt');
  process.stderr.write('MARK 47\n');
  const requestsMade = readFileSync(requests, 'utf8').trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
  process.stderr.write('MARK 48\n');
  assert.equal(requestsMade.length, 4, 'remote cell analysis, the two submit checks and landing each make one actual SSH worker request');
  process.stderr.write('MARK 49\n');
  assert.deepEqual(requestsMade.map(entry => entry.host), [runner, runner, runner, runner]);
  process.stderr.write('MARK 50\n');
  assert.ok(requestsMade.every(entry => entry.workerStarted && !entry.remoteHasSecret), 'every request executes the worker and keeps fixture secrets local');
  process.stderr.write('MARK 51\n');
}
