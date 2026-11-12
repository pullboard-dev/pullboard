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
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L44\n`);
  const settingsFile = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L45\n`);
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L46\n`);
  const probeBin = join(box.dir, 'registration-bin');
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L47\n`);
  mkdirSync(probeBin);
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L48\n`);
  installRegistrationProbeStandIn({ bin: probeBin });
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L49\n`);
  box.env.PATH = `${probeBin}:${box.env.PATH}`;
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L50\n`);
  // This case proves durable rotation, independently of the live-load ranking policy.
  const rotation = box.run(box.repo, 'settings', 'gate.loadAwareDispatch', 'off');
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L52\n`);
  assert.equal(rotation.code, 0, rotation.err);
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L53\n`);
  const hosts = ['a51', 'a52', 'a53'];
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L54\n`);
  for (const host of hosts) {
    const added = box.run(box.repo, 'runner', 'add', host, '--slots', '1', '--browser', '1');
    assert.equal(added.code, 0, `${host} is registered: ${added.err}`);
  }
  // With two or more runners the first is kept for timed checks by default; rotation needs every runner open to ordinary runs.
  const keptSettings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L60\n`);
  writeFileSync(settingsFile, JSON.stringify({ ...keptSettings, gate: { ...keptSettings.gate, timingRunner: false, runnerDispatch: 'controller' } }));
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L61\n`);
  const first = box.run(box.repo, 'settings', 'gate.runnersFirst', 'on');
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L62\n`);
  assert.equal(first.code, 0, first.err);
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L63\n`);
  const browserZero = box.run(box.repo, 'settings', 'browserSlots', '0');
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L64\n`);
  assert.equal(browserZero.code, 0, `registered runners allow browserSlots 0: ${browserZero.err}`);
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L65\n`);
  const gateZero = box.run(box.repo, 'settings', 'gateSlots', '0');
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L66\n`);
  assert.equal(gateZero.code, 0, `registered runners allow gateSlots 0: ${gateZero.err}`);
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L67\n`);
  const effective = JSON.parse(box.run(box.repo, 'settings', '--json').out).settings;
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L68\n`);
  assert.equal(effective.gate.runnersFirst, true);
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L69\n`);
  assert.equal(effective.gateSlots, 0);
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L70\n`);
  assert.equal(effective.browserSlots, 0);
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L71\n`);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(() => {
    const result = runPrivateGateLease(box);
    assert.equal(result.status, 0, result.context);
    return result.stdout.trim();
  }), ['a51', 'a52', 'a53', 'a51', 'a52', 'a53'], 'the durable cursor rotates across fresh process requests');

  const priorHome = process.env.PULLBOARD_HOME;
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L78\n`);
  const priorMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L79\n`);
  process.env.PULLBOARD_HOME = box.env.PULLBOARD_HOME;
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L80\n`);
  process.env.PULLBOARD_MACHINE_HOME = box.env.PULLBOARD_MACHINE_HOME;
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L81\n`);
  let releaseHeld;
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L82\n`);
  let heldRun;
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L83\n`);
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
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L110\n`);
  assert.equal(unreachable.status, 0, unreachable.context);
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L111\n`);
  assert.equal(unreachable.stdout.trim(), 'a51', 'an unreachable next runner is marked unavailable and skipped on its original queue request');
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L112\n`);

  const fallbackCapacity = box.run(box.repo, 'settings', 'gateSlots', '1');
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L114\n`);
  assert.equal(fallbackCapacity.code, 0, fallbackCapacity.err);
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L115\n`);
  const fallbackBrowser = box.run(box.repo, 'settings', 'browserSlots', '1');
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L116\n`);
  assert.equal(fallbackBrowser.code, 0, fallbackBrowser.err);
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L117\n`);
  // Every registered runner refuses once; with none reserved for timed checks that is one drop per host.
  const fallback = runPrivateGateLease(box, `if (lease.runner && remoteAttempts++ < ${hosts.length}) throw new RunnerDropped(lease.runner.host);`);
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L119\n`);
  assert.equal(fallback.status, 0, fallback.context);
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L120\n`);
  assert.equal(fallback.stdout.trim(), 'local', 'after registered runners refuse, runner-first uses the available local slot');
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L121\n`);

  const noRunner = e2e.privateCheckSubmission({ check: 'true' });
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L123\n`);
  const refusedGate = noRunner.run(noRunner.repo, 'settings', 'gateSlots', '0');
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L124\n`);
  assert.notEqual(refusedGate.code, 0);
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L125\n`);
  assert.match(refusedGate.err, /BAD_GATE_SLOTS/u);
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L126\n`);
  assert.match(refusedGate.err, /registered runner/u);
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L127\n`);
  const refusedBrowser = noRunner.run(noRunner.repo, 'settings', 'browserSlots', '0');
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L128\n`);
  assert.notEqual(refusedBrowser.code, 0);
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L129\n`);
  assert.match(refusedBrowser.err, /BAD_BROWSER_SLOTS/u);
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L130\n`);
  assert.match(refusedBrowser.err, /registered runner/u);
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L131\n`);
  assert.ok(readFileSync(settingsFile, 'utf8').includes('runnersFirst'), 'the opted-in policy is persisted only in the private fixture');
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L132\n`);

  // Public submit and landing-gate entry exercise the real worker transport. This does not claim
  // the coordinator-only `pullboard land` orchestration itself ran here.
  const integrated = e2e.project('true');
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L136\n`);
  const runner = HOST;
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L137\n`);
  const runnerBin = join(integrated.dir, 'submit-land-bin');
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L138\n`);
  const worker = join(integrated.dir, 'submit-land-worker');
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L139\n`);
  const remoteHome = join(integrated.dir, 'submit-land-home');
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L140\n`);
  const remoteMachineHome = join(remoteHome, '.pullboard');
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L141\n`);
  const requests = join(integrated.dir, 'submit-land-ssh-requests.jsonl');
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L142\n`);
  for (const folder of [runnerBin, worker, remoteHome, remoteMachineHome]) mkdirSync(folder, { recursive: true });
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L143\n`);
  integrated.env.PATH = `${runnerBin}:${integrated.env.PATH}`;
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L144\n`);
  installSshStandIn({ bin: runnerBin, worker, home: remoteHome, machineHome: remoteMachineHome, requests });
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L145\n`);
  // Filed before any runner exists, and waited for: with one registered the add's baseline run would be a fourth request.
  const added = fixtureAdd(integrated.run, integrated.repo, 'web', 'Runner-first public submit', '--specs', 'G1',
    '--criterion', 'the runner executes the submitted gate', '--check', `${process.execPath} -e "setTimeout(() => {}, 1000)"`, '--wait', '--json');
  assert.equal(added.code, 0, added.err);
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L149\n`);
  const id = JSON.parse(added.out).item.item_id;
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L150\n`);
  const registered = integrated.run(integrated.repo, 'runner', 'add', runner, '--slots', '1', '--browser', '1');
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L151\n`);
  assert.equal(registered.code, 0, registered.err);
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L152\n`);
  for (const [key, value] of [['gate.runnersFirst', 'on'], ['browserSlots', '0'], ['gateSlots', '0']]) {
    const setting = integrated.run(integrated.repo, 'settings', key, value);
    assert.equal(setting.code, 0, `${key} ${value}: ${setting.err}`);
  }
  // The settings writes above must not leave the submitting process waiting on a pull runner; pin controller dispatch again [P7].
  const integratedSettings = join(integrated.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L158\n`);
  const integratedKept = JSON.parse(readFileSync(integratedSettings, 'utf8'));
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L159\n`);
  writeFileSync(integratedSettings, JSON.stringify({ ...integratedKept, gate: { ...integratedKept.gate, runnerDispatch: 'controller' } }));
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L160\n`);
  assert.equal(integrated.run(integrated.web, 'claim', String(id)).code, 0);
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L161\n`);
  const built = e2e.commitFile(integrated, integrated.web, 'web/runner-first.txt', 'submitted on runner\n', 'feat(web): add runner-first fixture [G1]');
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L162\n`);
  assert.equal(built.status, 0, built.stderr);
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L163\n`);
  const submittedCommit = integrated.git(integrated.web, 'rev-parse', 'HEAD');
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L164\n`);
  const submitted = integrated.run(integrated.web, 'submit', String(id), '--json');
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L165\n`);
  assert.equal(submitted.code, 0, `${submitted.out}\n${submitted.err}`);
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L166\n`);
  const submittedDocument = JSON.parse(submitted.out);
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L167\n`);
  const submitGateProfile = JSON.parse(readFileSync(submittedDocument.gate.check.profilePath, 'utf8'));
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L168\n`);
  const submitProofProfile = JSON.parse(readFileSync(submittedDocument.gate.proofProfilePath, 'utf8'));
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L169\n`);
  assert.equal(submitGateProfile.executionRunner, runner, 'public submit executes on the registered runner');
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L170\n`);
  assert.equal(submitGateProfile.executionSource?.commit, submittedCommit, 'the worker receipt binds the submitted check');
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L171\n`);
  assert.equal(submitGateProfile.receipt?.runner?.id, runner, 'the submit check records the actual runner admission receipt');
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L172\n`);
  assert.equal(submitProofProfile.executionSource?.commit, submittedCommit, 'the worker receipt binds the submitted proof');
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L173\n`);
  assert.equal(submitProofProfile.receipt?.runner?.id, runner, 'the submit proof records the actual runner admission receipt');
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L174\n`);

  const submitRequests = readFileSync(requests, 'utf8').trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L176\n`);
  assert.equal(submitRequests.length, 3, 'remote cell analysis, criterion and proof each make one actual SSH worker request');
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L177\n`);

  const landingGate = integrated.run(integrated.repo, 'gate', '--landing', '--json');
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L179\n`);
  assert.equal(landingGate.code, 0, `${landingGate.out}\n${landingGate.err}`);
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L180\n`);
  const landingProfile = JSON.parse(readFileSync(join(integrated.repo, '.git', 'pullboard-gate.log.profile.json'), 'utf8'));
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L181\n`);
  assert.equal(landingProfile.executionRunner, runner, 'the public landing gate uses the registered runner');
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L182\n`);
  assert.equal(landingProfile.executionSource?.commit, integrated.git(integrated.repo, 'rev-parse', 'HEAD'),
    'the landing-gate worker receipt binds the exact main source it checked');
  assert.equal(landingProfile.receipt?.runner?.id, runner, 'the landing gate records the actual runner admission receipt');
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L185\n`);
  const requestsMade = readFileSync(requests, 'utf8').trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L186\n`);
  assert.equal(requestsMade.length, 4, 'remote cell analysis, the two submit checks and landing each make one actual SSH worker request');
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L187\n`);
  assert.deepEqual(requestsMade.map(entry => entry.host), [runner, runner, runner, runner]);
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L188\n`);
  assert.ok(requestsMade.every(entry => entry.workerStarted && !entry.remoteHasSecret), 'every request executes the worker and keeps fixture secrets local');
  (await import('node:fs')).appendFileSync('/tmp/claude-501/only-marks.log', `${new Date().toISOString()} L189\n`);
}
