/** Shared pieces of the pullboard check load-hold journeys: a seat holding a trivial check, the hold settings, and a check run under an injected load [C7,#10141]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setMachineLoadPort } from '../../../../packages/resources/index.js';
import { createE2eHelpers } from './e2e.js';
import { fileFixtureItem } from './testkit.js';

export const WAIT_LINE = 'pullboard check waits in the local resource line';

export const e2e = createE2eHelpers();

/** A fixture project whose seat holds item 1 with a trivial check, ready for pullboard check 1 --yes. */
export async function seat() {
  const box = e2e.project();
  await fileFixtureItem(box, box.repo, { lane: 'web', title: 'Check under load', check: 'true', wait: true, run: box.runLocal });
  const claimed = await box.runLocal(box.web, 'claim', '1');
  assert.equal(claimed.code, 0, claimed.err);
  return box;
}

/** Merge the machine hold settings into the fixture machine's settings file, keeping what the fixture wrote. */
export function holdSettings(box, machine) {
  const file = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(readFileSync(file, 'utf8')); } catch { /* the fixture wrote none */ }
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  writeFileSync(file, JSON.stringify({ ...settings, machine: { ...settings.machine, ...machine } }));
}

/**
 * Run the real pullboard check 1 --yes in this process with an injected 1-minute load of 30 on 4 cores, and collect what it writes to
 * stderr. Once the wait line appears the injected load drops to 0, so the held check admits and reports; `waited` says whether the line came first.
 */
export async function checkUnderLoad(t, box) {
  let loadNow = 30;
  const restore = setMachineLoadPort({ loadavg: () => [loadNow, loadNow, loadNow], cores: () => 4 });
  const savedHeld = process.env.PULLBOARD_GATE_SLOT_HELD;
  delete process.env.PULLBOARD_GATE_SLOT_HELD;
  const write = process.stderr.write;
  let seen = '';
  process.stderr.write = function capture(chunk, ...rest) {
    seen += String(chunk);
    if (seen.includes(WAIT_LINE)) loadNow = 0;
    return write.call(this, chunk, ...rest);
  };
  t.after(() => {
    process.stderr.write = write;
    restore();
    if (savedHeld === undefined) delete process.env.PULLBOARD_GATE_SLOT_HELD; else process.env.PULLBOARD_GATE_SLOT_HELD = savedHeld;
  });
  const result = await box.runLocal(box.web, 'check', '1', '--yes');
  return { result, seen, waitedFirst: seen.includes(WAIT_LINE) && result.out.includes('check green in') };
}

