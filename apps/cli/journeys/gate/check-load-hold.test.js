/** With machine.holdHeavyAboveLoad on, pullboard check waits in the local resource line above machine.loadCeiling and says so; off, it reports as before [C7,#10141]. @pullboard-test-input source-cell apps/cli packages/config packages/resources */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const WAIT_LINE = 'pullboard check waits in the local resource line';

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** A fixture project whose seat holds item 1 with a trivial check, ready for pullboard check 1 --yes. */
async function seat() {
  const box = e2e.project();
  await fileFixtureItem(box, box.repo, { lane: 'web', title: 'Check under load', check: 'true', wait: true, run: box.runLocal });
  const claimed = await box.runLocal(box.web, 'claim', '1');
  assert.equal(claimed.code, 0, claimed.err);
  return box;
}

/** Merge the machine hold settings into the fixture machine's settings file, keeping what the fixture wrote. */
function holdSettings(box, machine) {
  const file = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(readFileSync(file, 'utf8')); } catch { /* the fixture wrote none */ }
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  writeFileSync(file, JSON.stringify({ ...settings, machine: { ...settings.machine, ...machine } }));
}

/** Run the real pullboard check 1 --yes in the seat as a child, outside any admitted gate run; resolves with what it printed when it exits or once `until` matches (then the child is killed). */
function checkChild(t, box, until) {
  const env = { ...box.env, PULLBOARD_OWN_CLI: '1', PULLBOARD_RESIDENT: '0' };
  delete env.PULLBOARD_GATE_SLOT_HELD;
  const child = spawn(process.execPath, [`${ROOT}apps/cli/pullboard.js`, 'check', '1', '--yes'], { cwd: box.web, env });
  t.after(() => child.kill());
  return new Promise(resolve => {
    let out = '';
    const read = chunk => {
      out += chunk;
      if (until && out.includes(until)) { child.kill(); resolve({ out, killed: true }); }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('close', code => { resolve({ out, code, killed: false }); });
  });
}

test('clause 1: with the setting on and machine.loadCeiling 0.0001, pullboard check waits in the local resource line before it reports [C7,#10141]', { timeout: 180_000 }, async t => { // budget: hang ceiling for one real CLI child; not a speed target.
  const box = await seat();
  holdSettings(box, { holdHeavyAboveLoad: true, loadCeiling: 0.0001 });
  const answer = await checkChild(t, box, WAIT_LINE);
  assert.equal(answer.killed, true, `the check waits instead of reporting: ${answer.out}`);
  assert.match(answer.out, new RegExp(`${WAIT_LINE}: load: holding heavy local work`, 'u'));
  assert.doesNotMatch(answer.out, /check (green|red) in/u, 'the check has not reported');
});

test('clause 2: with the setting off, the same check reports green and prints no wait line [C7,#10141]', { timeout: 180_000 }, async t => {
  const box = await seat();
  holdSettings(box, { holdHeavyAboveLoad: false, loadCeiling: 0.0001 });
  const answer = await checkChild(t, box, null);
  assert.equal(answer.code, 0, answer.out);
  assert.match(answer.out, /check green in/u);
  assert.doesNotMatch(answer.out, new RegExp(WAIT_LINE, 'u'));
});
