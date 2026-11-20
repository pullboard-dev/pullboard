/** next passes over an item whose readiness command exits non-zero and prints the command output, behind next.readinessCheck [C7,#8793]. @pullboard-test-input source-cell apps/cli packages/config */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { machineSettingsFile } from '../../../../../packages/config/index.js';
import { main } from '../../fixtures/native.js';
import { fixture } from '../../fixtures/next/take.js';

/** Turn next.readinessCheck on or off for this fixture's machine, keeping the settings the fixture wrote. */
function readinessCheck(on) {
  const file = machineSettingsFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ view: { background: false }, relay: { offerAtInit: false }, gate: { localRunner: false }, next: { readinessCheck: on } }));
}

/** Run next as a person reads it, with no --json, and return everything it printed. */
async function printed(box, cwd) {
  let out = '';
  const stdout = { isTTY: false, write: part => { out += part; } };
  const code = await main(['next'], { cwd, clock: box.clock, stdout, stderr: stdout });
  assert.equal(code, 0, out);
  return out;
}

/** Item 1 carries a failing readiness command that prints a reason; item 2 has none. */
async function notReadyThenPlain(t, on) {
  const box = await fixture(t);
  const blocked = box.add('Waits on a service', { readinessCommand: 'echo database is down; exit 3' });
  const plain = box.add('Ready to build');
  readinessCheck(on);
  return { box, blocked, plain };
}

test('cli.io-next-readiness.cli-next-readiness-next-does-not-offer: cli.next.readiness.next-does-not-offer-an-item: clause 1: next does not offer an item whose readiness command exits non-zero and prints that command output [C7,#8793]', async t => {
  const { box, blocked, plain } = await notReadyThenPlain(t, true);
  const text = await printed(box, box.seats.actor.path);
  assert.match(text, new RegExp(`skipped #${blocked}: .*echo database is down; exit 3.*exited 3: database is down`, 'u'), 'the skip names the command, its exit code and its output');
  assert.match(text, new RegExp(`claimed #${plain}: Ready to build`, 'u'), 'the ready item is claimed instead');
  assert.doesNotMatch(text, new RegExp(`claimed #${blocked}:`, 'u'));
});

test('cli.io-next-readiness.cli-next-readiness-with-next-readinesscheck-off: cli.next.readiness.with-next-readinesscheck-off-next-offers: clause 1: with next.readinessCheck off next offers the item as before [C7,#8793]', async t => {
  const { box, blocked } = await notReadyThenPlain(t, false);
  const text = await printed(box, box.seats.actor.path);
  assert.match(text, new RegExp(`claimed #${blocked}: Waits on a service`, 'u'));
  assert.doesNotMatch(text, /skipped #/u);
});
