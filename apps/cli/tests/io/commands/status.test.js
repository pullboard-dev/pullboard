/** The status command puts live builders per route beside the ready items per route and prints one ready buffer line per route [C7,#12475]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cli } from '../../fixtures/next/take.js';
import { fixture } from '../../fixtures/next/take.js';
import { main } from '../../fixtures/native.js';

test('cli.io-commands-status.ready-buffer: clause 2: the real status command carries buildersByRoute beside readyByRoute and prints a ready buffer line for each route [C7,#12475]', async (t) => {
  const box = await fixture(t);
  for (const title of ['First ready item', 'Second ready item']) box.add(title);
  const json = await cli(box, box.root, ['status']);
  assert.equal(json.code, 0, json.out + json.err);
  const { capacity } = json.document;
  assert.deepEqual(Object.keys(capacity.buildersByRoute).sort(), Object.keys(capacity.readyByRoute).sort());
  for (const builders of Object.values(capacity.buildersByRoute)) assert.ok(Number.isInteger(builders) && builders >= 0);
  let out = '';
  const code = await main(['status'], { cwd: box.root, clock: box.clock, stdout: { isTTY: false, write: (part) => { out += part; } }, stderr: { write: () => {} } });
  assert.equal(code, 0, out);
  for (const [route, ready] of Object.entries(capacity.readyByRoute)) {
    const builders = capacity.buildersByRoute[route];
    const rest = builders > 0 ? `${builders} builders = ${(ready / builders).toFixed(1)}x` : 'no builders';
    assert.ok(out.split('\n').includes(`ready buffer: ${route} ${ready} ready, ${rest}`), `status prints the ${route} ready buffer line`);
  }
});
