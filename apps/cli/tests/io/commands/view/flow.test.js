/** @pullboard-test-input apps/cli/src/io/commands/view.js apps/cli/tests/fixtures/next/take.js */
/** The real foreground view serves the board's Flow rows and idle seats [N26,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main } from '../../../fixtures/native.js';
import { cli } from '../../../fixtures/next/take.js';
import { fixture } from '../../../fixtures/next/take.js';
import { fetchPrintedViewLink } from '../../../fixtures/view/link.js';

test('cli.io-commands-view.home-carries-flow-panel: clause 1: the real foreground view serves each unlanded releaseFlow row with its actual cause, omits a merged control and lists every idle seat; clause 2: it preserves the full Flow panel behavior [N26,C7]', { timeout: 120_000 }, async t => {
  const box = await fixture(t);
  const free = box.add('Flow free control');
  const held = box.add('Flow held control');
  const heldResult = await cli(box, box.root, ['hold', String(held), 'fixture hold']);
  assert.equal(heldResult.code, 0, heldResult.out + heldResult.err);
  const reviewing = box.add('Flow reviewing control');
  box.submit(reviewing);
  const landed = box.add('Flow landed control');
  const landedCommit = box.git(box.root, 'rev-parse', 'HEAD');
  const mergedResult = await cli(box, box.root, ['merged', String(landed), landedCommit, '--forced', 'fixture landed control', '--waive-proof', 'synthetic fixture only']);
  assert.equal(mergedResult.code, 0, mergedResult.out + mergedResult.err);

  const registered = await cli(box, box.root, ['init', '--no-open']);
  assert.equal(registered.code, 0, registered.out + registered.err);
  const previousForeground = process.env.PULLBOARD_VIEW_FOREGROUND;
  process.env.PULLBOARD_VIEW_FOREGROUND = '1';
  let pending;
  t.after(async () => {
    if (pending) {
      process.emit('SIGTERM');
      await pending;
    }
    if (previousForeground === undefined) delete process.env.PULLBOARD_VIEW_FOREGROUND;
    else process.env.PULLBOARD_VIEW_FOREGROUND = previousForeground;
  });

  let out = '';
  const link = await new Promise((found, fail) => {
    pending = main(['view', '--project', '--no-open', '--port', '0', '--json'], { cwd: box.root, clock: box.clock, stdin: process.stdin,
      stdout: { isTTY: false, write: part => {
        out += part;
        try { found(new URL(JSON.parse(out).url)); } catch { /* wait for the complete JSON response */ }
        return true;
      } }, stderr: { isTTY: false, write: () => true } }).then(code => fail(new Error(`view exited early with code ${code}`)));
  });
  const page = await (await fetchPrintedViewLink(link)).text();
  const card = page.match(/<div class="sx-card sx-flow">([\s\S]*?)<\/section>/u)?.[1];
  assert.ok(card, 'the real served home page carries the Flow card');

  const expected = new Map([[free, 'free'], [held, 'held'], [reviewing, 'review']]);
  const rows = [...card.matchAll(/<div class="sx-fl"><code>#(\d+)<\/code><span class="sx-it">([^<]+)<\/span><\/div>/gu)]
    .map(([, id, cause]) => [Number(id), cause]);
  rows.sort(([left], [right]) => left - right);
  assert.equal(rows.length, expected.size, `there is one Flow row for each unlanded item; received: ${card}`);
  assert.deepEqual(rows, [...expected].sort(([left], [right]) => left - right).map(([id, cause]) => [id, cause]), "each row has the item's actual releaseFlow cause");
  assert.equal(rows.some(([id]) => id === landed), false, 'the merged control is absent');

  const idle = card.match(/<div class="sx-fl sx-flidle">([\s\S]*?)<\/div>/u)?.[1];
  assert.ok(idle, 'the Flow card lists idle seats');
  const idleSeats = [...idle.matchAll(/<code>([^<]+)<\/code>/gu)].map(([, seat]) => seat);
  const expectedIdle = ['coordinator', ...Object.values(box.seats).map(seat => seat.id)];
  assert.deepEqual(idleSeats, expectedIdle, 'every seat not holding an item appears once');
  assert.ok((idle.match(/work available/gu) ?? []).length >= 2, 'multiple idle seats with eligible work are shown');
});
