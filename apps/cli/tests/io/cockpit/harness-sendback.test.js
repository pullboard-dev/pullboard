/** @pullboard-test-gui */
/** The cockpit harness's sendBack answers its show read and reject in this process, with the same result as the real-process call [C7,U149]. */
import assert from 'node:assert/strict';
import { before } from 'node:test';
import { test } from 'node:test';
import { sendBack } from '../../fixtures/cockpit/harness.js';
import { sendBackLocal } from '../../fixtures/cockpit/harness.js';
import { nodeLaunches } from '../../fixtures/launch-count.js';
import { NOTE } from '../../fixtures/sendback.js';
import { afterwards } from '../../fixtures/sendback.js';
import { submitted } from '../../fixtures/sendback.js';

let viaProcess;
let viaLocal;
let launches;

/** Run one setup step and print its name with the milliseconds it took, so the file's time shows where it goes. */
async function step(name, run) {
  const started = Date.now();
  const result = await run();
  console.log(`harness-sendback setup step ${name}: ${Date.now() - started} ms`);
  return result;
}

before(async () => {
  viaProcess = await step('first submitted box', submitted);
  viaLocal = await step('second submitted box', submitted);
  launches = {
    real: await step('real sendBack', () => nodeLaunches(async () => sendBack(viaProcess.box, viaProcess.demo, 1, NOTE))),
    local: await step('local sendBack', () => nodeLaunches(() => sendBackLocal(viaLocal.box, viaLocal.demo, 1, NOTE))),
  };
});

test('cli.io-cockpit-harness-sendback.sendback-as-a-real-process-and-sendbacklocal: clause 1: sendBack as a real process and sendBackLocal in this process both exit clean and leave the same item and board state [C7,U149]', async () => {
  // Each helper's box refuses a non-zero exit, so reaching this point is the equal exit code.
  const real = await afterwards(viaProcess);
  assert.deepEqual(await afterwards(viaLocal), real);
  assert.equal(real.noted, true, 'the reject note is on the item');
});

test('cli.io-cockpit-harness-sendback.sendbacklocal-starts-no-cli-process-and-finishes: clause 2: sendBackLocal starts no CLI process and finishes under 40 s alone [C7,U149]', { timeout: 40_000 }, () => {
  assert.equal(launches.local, 0, 'no node child starts for the show read or the reject');
  assert.ok(launches.real >= 2, 'the real helper does start node children, so the count is live');
});
