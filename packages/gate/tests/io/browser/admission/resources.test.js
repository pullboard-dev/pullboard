import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { checkNeedsBrowser } from '../../../../src/io/browser/admission.js';
import { executionServicesSource } from '../../../fixtures/execution.js';
import { capacityChangeCases } from '../../../fixtures/resources/capacity.js';
import { releaseQueueProof } from '../../../fixtures/resources/release.js';
import { openKitBoard } from '../../../../../board/tests/fixtures/cell-board.js';
import { machineSettings } from '../../../fixtures/admission/settings.js';
import { cpuCheckRepo } from '../../../fixtures/admission/cpu.js';
import { POOL_MODULE_WORKER } from '../../../fixtures/admission/pool.js';
import { PRE_RUNNER_MODULE } from '../../../fixtures/admission/pool.js';
import { acquired } from '../../../fixtures/admission/pool.js';
import { event } from '../../../fixtures/admission/pool.js';
import { fixture } from '../../../fixtures/admission/pool.js';
import { poolWorker } from '../../../fixtures/admission/pool.js';
import { privateList } from '../../../fixtures/admission/pool.js';
import { release } from '../../../fixtures/admission/pool.js';
import { worker } from '../../../fixtures/admission/pool.js';
/** Real-process resource queue and lease coverage [Q1,Q2,Q3]. */
test('gate.io-browser-admission-resources.single-quoted-named-test-checks-skip: single-quoted named-test checks skip the browser slot [C7]', async () => {
  const box = fixture();
  const { repo } = cpuCheckRepo(box);
  const itemCheck = 'node apps/cli/src/io/run/tests.js --test-name-pattern "item check marker" test/cpu-check.test.js';
  /** Keep assertions about the parser independent of worker custody inherited by the test process. */
  const classify = command => checkNeedsBrowser(repo, command, { env: { ...process.env, NODE_OPTIONS: '' } });
  assert.equal(await classify(itemCheck), false, 'an explicit CPU-only test file is classifiable');
  const outputPattern = '^[[:space:]]*ok [0-9]+ - item check marker';
  const newlinePrint = ([quote, backslashes]) => `printf ${quote}%s${'\\'.repeat(backslashes)}n${quote} "$out"`;
  const capturedCheck = (formats, patternQuotes) => `out=$(${itemCheck} 2>&1); ${newlinePrint(formats[0])}; ${newlinePrint(formats[1])} | grep -Eq ${patternQuotes[0]}${outputPattern}${patternQuotes[0]} && ${newlinePrint(formats[2])} | grep -Eq ${patternQuotes[1]}^# fail 0$${patternQuotes[1]}`;
  const oneBackslash = [1, 1, 1];
  const accepted = [
    { formats: oneBackslash.map(count => ['\'', count]), patternQuotes: ['\'', '\''] },
    { formats: [['\'', 1], ['"', 1], ['\'', 1]], patternQuotes: ['"', '\''] },
    { formats: [['"', 1], ['\'', 1], ['"', 1]], patternQuotes: ['\'', '"'] },
    { formats: oneBackslash.map(count => ['"', count]), patternQuotes: ['"', '"'] },
  ];
  for (const variant of accepted) {
    assert.equal(await classify(capturedCheck(variant.formats, variant.patternQuotes)), false,
      `the exact capture wrapper accepts quote changes with one literal backslash: ${JSON.stringify(variant)}`);
  }
  for (let index = 0; index < 3; index += 1) {
    const formats = oneBackslash.map(count => ['\'', count]);
    formats[index] = ['\'', 2];
    assert.equal(await classify(capturedCheck(formats, ['\'', '\''])), true,
      `a two-backslash printf at position ${index + 1} stays browser-gated`);
  }
  assert.equal(await classify(`${capturedCheck(accepted[0].formats, accepted[0].patternQuotes)}; :`), true,
    'an arbitrary suffix remains outside the exact capture wrapper');
  const substituted = capturedCheck(accepted[0].formats, accepted[0].patternQuotes)
    .replace('printf \'%s\\n\' "$out"', 'printf \'%s\\n\' "$(printf %s "$out")"');
  assert.equal(await classify(substituted), true, 'a command substitution remains outside the exact printf wrapper');
  assert.equal(await classify('node apps/cli/src/io/run/tests.js test/cockpit/brief.test.js'), true,
    'a named file with no readable declaration stays browser-gated');
  assert.equal(await checkNeedsBrowser(repo, itemCheck, {
    env: { ...process.env, NODE_OPTIONS: '--import=unknown-preload.mjs' },
  }), true, 'an unclassified preload keeps the check browser-gated');
});






/** Prove the machine setting changes real browser admission while retaining the single-slot default [C7]. */
test('gate.io-browser-admission-resources.browserslots-admits-that-many-browser-runs: browserSlots admits that many browser runs and no more [C7]', async () => {
  const defaults = fixture();
  const defaultSettings = machineSettings(defaults, 'loadMachineSettings');
  assert.equal(defaultSettings.error, undefined, defaultSettings.error?.message);
  assert.equal(defaultSettings.value.browserSlots, 1, 'an unset machine keeps the existing single browser slot');

  const box = fixture();
  const configured = machineSettings(box, 'setBrowserSlots', 2);
  assert.equal(configured.error, undefined, configured.error?.message);
  assert.equal(configured.value.browserSlots, 2);
  const readBack = machineSettings(box, 'loadMachineSettings');
  assert.equal(readBack.error, undefined, readBack.error?.message);
  assert.equal(readBack.value.browserSlots, 2, 'the machine setting persists for other processes');
  assert.equal(privateList(box).find(({ name }) => name === 'browser').capacity, 2,
    'the shared browser resource row has the configured capacity before workers start');
  const invalid = machineSettings(box, 'setBrowserSlots', 3);
  assert.ok(invalid.error, 'a browser capacity above the gate capacity is refused');
  assert.equal(invalid.error.code, 'BAD_BROWSER_SLOTS');
  assert.match(invalid.error.message, /pullboard settings gateSlots/u);

  const first = poolWorker(box, { agent: 'browser-one', browser: true });
  assert.equal((await acquired(first)).acquired, 'browser-one');
  const second = poolWorker(box, { agent: 'browser-two', browser: true });
  const secondStart = await event(second);
  if (!secondStart.acquired) {
    const gate = privateList(box).find(({ name }) => name === 'gate');
    const browser = privateList(box).find(({ name }) => name === 'browser');
    assert.fail(`the configured second browser lease queued: ${JSON.stringify({ state: secondStart.queued, gate, browser })}`);
  }
  assert.equal(secondStart.acquired, 'browser-two', 'the configured second browser lease starts while the first is held');
  const third = poolWorker(box, { agent: 'browser-three', browser: true });
  assert.equal((await event(third)).queued.position, 1, 'the next browser run waits for a configured slot');
  const browser = privateList(box).find(({ name }) => name === 'browser');
  assert.equal(browser.capacity, 2, 'resource listing reflects the machine browserSlots setting');
  assert.equal(browser.holders.length, 2);
  assert.deepEqual(browser.holders.map(({ agent }) => agent).sort(), ['browser-one', 'browser-two']);
  assert.deepEqual(browser.line.map(({ agent }) => agent), ['browser-three']);

  await release(first);
  assert.equal((await acquired(third)).acquired, 'browser-three', 'a released browser lease admits the oldest waiting browser run');
  await release(second);
  await release(third);
});

const capacityCases = capacityChangeCases({ machineSettings, fixture, worker, event, acquired, release, privateList, poolWorker, POOL_MODULE_WORKER });

/** Existing queued processes observe a raised limit without restarting their holders [Q1,Q2,Q4]. */
test('gate.io-browser-admission-resources.raising-a-busy-resource-s-capacity: raising a busy resource\'s capacity admits waiters at once [Q1,Q2,Q4]', capacityCases.raising);

/** A refused decrease names the live holders and leaves their leases and settings intact [Q1,Q3,Q4]. */
test('gate.io-browser-admission-resources.lowering-capacity-never-stops-a-running: lowering capacity never stops a running holder [Q1,Q3,Q4]', capacityCases.lowering);

/** Browser capacity can grow under the same live gate lease without exceeding either limit [Q1,Q2,Q4]. */
test('gate.io-browser-admission-resources.raising-busy-browser-capacity-admits-only: raising busy browser capacity admits only the new browser slots [Q1,Q2,Q4]', capacityCases.browser);

test('gate.io-browser-admission-resources.the-gate-pool-serves-the-current: the gate pool serves the current release first [C7,V4]', () => releaseQueueProof({ openKitBoard, machineSettings, executionServicesSource, fixture, poolWorker, privateList, event, acquired, release, legacyModule: PRE_RUNNER_MODULE }));
