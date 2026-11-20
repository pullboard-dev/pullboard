/** show prints who holds an item reservation, behind route.reservations [C7,#9178]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { reserveItem } from '../../../../packages/board/index.js';
import { machineSettingsFile } from '../../../../packages/config/index.js';
import { main } from '../../tests/fixtures/native.js';
import { fixture } from '../../tests/fixtures/next/take.js';

/** Turn route.reservations on or off for this fixture's machine, keeping the settings the fixture wrote. */
function reservations(on) {
  const file = machineSettingsFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ view: { background: false }, relay: { offerAtInit: false }, gate: { localRunner: false }, route: { reservations: on } }));
}

/** A reserved item and an unreserved one, with the setting as asked; returns what show printed for each. */
async function shown(t, on) {
  const box = await fixture(t);
  const reserved = box.add('Reserved item', { brief: 'Files: web/reserved.js' });
  const plain = box.add('Unreserved item', { brief: 'Files: web/plain.js' });
  reserveItem(box.board, reserved, { agentId: 'coordinator', holder: 'web-7' });
  reservations(on);
  const print = async id => {
    let out = '';
    const stdout = { isTTY: false, write: part => { out += part; } };
    const code = await main(['show', String(id)], { cwd: box.root, clock: box.clock, stdout, stderr: stdout });
    assert.equal(code, 0, out);
    return out;
  };
  return { reserved: await print(reserved), plain: await print(plain) };
}

test('cli.journeys-next-reservations.with-route-reservations-on-show-prints-the-holder: clause 1: with route.reservations on, show prints the reservation holder on a reserved item and no reservation line on an unreserved one [C7,#9178]', async t => {
  const { reserved, plain } = await shown(t, true);
  assert.match(reserved, /reserved for web-7 by coordinator/u);
  assert.doesNotMatch(plain, /reserved for/u);
});

test('cli.journeys-next-reservations.with-route-reservations-off-show-prints-nothing-new: clause 2: with route.reservations off, show prints no reservation line on a reserved item [C7,#9178]', async t => {
  const { reserved } = await shown(t, false);
  assert.doesNotMatch(reserved, /reserved for/u);
});
