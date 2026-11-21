/** The status command puts live builders per route beside the ready items per route and prints one ready buffer line per route [C7,#12475]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cli } from '../../fixtures/next/take.js';
import { fixture } from '../../fixtures/next/take.js';
import { main } from '../../fixtures/native.js';
import { getItem } from '../../../../../packages/store/index.js';
import { holdItem } from '../../../../../packages/store/index.js';
import { recordSubmitHandoff } from '../../../../../packages/jobs/index.js';

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

test('cli.io-commands-status.eligible-ready: clause 1: status readyByRoute counts only the items next would offer, not a held item, a gate-queued item or a claim waiting to land [C7,#12567]', async (t) => {
  const box = await fixture(t);
  const { board } = box;
  const place = (id, fields) => {
    board.db.exec('INSERT INTO temp.moving (token) VALUES (1)');
    try { board.db.prepare(`UPDATE item SET ${Object.keys(fields).map(key => `${key}=?`).join(', ')} WHERE item_id=?`).run(...Object.values(fields), id); }
    finally { board.db.exec('DELETE FROM temp.moving'); }
  };
  const file = name => ({ brief: `Files: web/${name}.js\nTest: the real status command counts what next offers.` });
  const ids = { mid: box.add('Eligible mid', { route: 'mid', ...file('a') }), strong: box.add('Eligible strong', { route: 'strong', ...file('b') }),
    held: box.add('Held', { route: 'mid', ...file('c') }), gate: box.add('Gate queued at head', { route: 'mid', ...file('d') }),
    waiting: box.add('Claim waiting to land', { route: 'strong', ...file('e') }) };
  holdItem(board, ids.held, { agentId: 'coordinator', reason: 'Fixture hold.' });
  box.submit(ids.gate);
  recordSubmitHandoff(board.db, ids.gate, { id: `fixture-${ids.gate}`, commit: getItem(board, ids.gate).item_commit, agentId: box.seats.builder.id, state: 'queued' });
  place(ids.gate, { item_status: 'open', item_owner: null });
  board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(`claim_waiting:${ids.waiting}`, JSON.stringify([ids.mid]));
  const json = await cli(box, box.root, ['status']);
  assert.equal(json.code, 0, json.out + json.err);
  const { capacity, capacityForecast, reviewQueue } = json.document;
  assert.deepEqual(capacity.readyByRoute, { mid: 1, strong: 1 });
  assert.equal(capacity.readyItems, 2);
});

test('cli.io-commands-status.eligible-recommended: clause 2: status recommends the eligible ready count plus one reviewer per 20 pending reviews, rounded up [C7,#12567]', async (t) => {
  const box = await fixture(t);
  for (const title of ['First eligible', 'Second eligible']) box.add(title, { brief: `Files: web/${title.split(' ')[0]}.js\nTest: the real status command recommends from eligibility.` });
  const json = await cli(box, box.root, ['status']);
  assert.equal(json.code, 0, json.out + json.err);
  const { capacity, capacityForecast, reviewQueue } = json.document;
  assert.equal(capacity.readyItems, 2);
  assert.equal(capacityForecast.agents.recommended, capacity.readyItems + Math.ceil((reviewQueue.pending ?? 0) / 20));
});
