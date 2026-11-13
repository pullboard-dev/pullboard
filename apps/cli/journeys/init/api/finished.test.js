/** A first state read carries open work first; finished and withdrawn items come from their own read, and deltas keep both honest (A2, N26). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { viewApiPorts } from '../../../../view/index.js';
import { expandItemSummaries } from '../../../../view/index.js';
import { apiHttpFixture } from '../../../tests/fixtures/api.js';
import { apiBoardOpeners } from '../../../tests/fixtures/board.js';
import { main } from '../../../tests/fixtures/native.js';
import { refusalDocument } from '../../../index.js';
import { fetchFresh } from '../../../tests/fixtures/http.js';
import { applyStateDelta } from '../../../../../packages/api/index.js';
import { serveApi } from '../../../../../packages/api/index.js';

const BRIEF = 'Files:\n- app/fixture.js\nChange:\n- Keep the fixture valid.\nTest:\n- the fixture case passes';

/** Serve one private board and give a caller that reads and writes it over HTTP, returning each reply's text and status. */
async function served(t) {
  const box = apiHttpFixture(t);
  const api = await serveApi({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, runCommand: main, projects: () => [{ root: box.root, name: 'HTTP fixture' }] });
  t.after(() => api.close());
  const url = new URL(api.url);
  const call = async (path, value) => {
    const response = await fetchFresh(url.origin + path, { method: value === undefined ? 'GET' : 'POST', headers: { 'x-pullboard-key': url.searchParams.get('k'), ...(value === undefined ? {} : { 'content-type': 'application/json' }) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    return { status: response.status, json: JSON.parse(await response.text()) };
  };
  const path = '/api/v1/boards/' + (await call('/api/v1/boards')).json.boards[0].id;
  const add = async (title) => (await call(path + '/moves', { verb: 'add', args: { lane: 'app', title, criterion: 'complete', specs: 'G1', brief: BRIEF } })).json.result.item.item_id;
  return { box, call, path, add };
}

test('[A2, N26] a first state read sends open work only with the finished counts, GET /finished sends the rest, and together they are the whole board [#6588]', async (t) => {
  const { box, call, path, add } = await served(t);
  const [keep, gone] = [await add('Keep working'), await add('Withdraw this')];
  await box.cliLocal(box.root, 'withdraw', String(gone), 'superseded by a design choice');
  const open = (await call(path + '/state?items=compact&finished=omit')).json.state;
  const everything = expandItemSummaries((await call(path + '/state?items=compact')).json.state);
  const first = expandItemSummaries(open);
  assert.deepEqual(first.items.map((item) => item.id), [keep]);
  assert.equal(first.itemsOmitted, 'finished');
  assert.deepEqual(first.finished, { verified: 0, withdrawn: 1 });
  assert.equal(everything.items.length, 2);
  const rest = await call(path + '/finished');
  assert.equal(rest.status, 200);
  assert.equal(rest.json.version, 1);
  const finished = expandItemSummaries(rest.json.state).items;
  assert.deepEqual(finished.map((item) => [item.id, item.status]), [[gone, 'withdrawn']]);
  assert.deepEqual([...first.items, ...finished].map((item) => item.id).sort(), everything.items.map((item) => item.id).sort());
});

test('[A2, N26] a delta applied to an open-first state holds no hole for an item it was never sent, and counts the finished items again [#6588]', async (t) => {
  const { box, call, path, add } = await served(t);
  const [keep, gone, later] = [await add('Keep working'), await add('Withdraw this'), await add('Withdraw later')];
  await box.cliLocal(box.root, 'withdraw', String(gone), 'superseded by a design choice');
  const first = expandItemSummaries((await call(path + '/state?items=compact&finished=omit')).json.state);
  await box.cliLocal(box.root, 'withdraw', String(later), 'superseded by a later design choice');
  const reply = (await call(path + '/state?since=' + first.sequence)).json;
  assert.ok(reply.delta, 'a delta from the open-first base');
  const next = applyStateDelta(first, reply.delta);
  assert.ok(next.items.every((item) => item && typeof item.id === 'number'), 'no hole where a finished item was never sent');
  assert.deepEqual(next.items.map((item) => item.id).sort(), [keep, later].sort());
  assert.deepEqual(next.finished, { verified: 0, withdrawn: 2 });
});

test('[A2] finished=omit is refused without compact items or with since, and POST to /finished is refused [#6588]', async (t) => {
  const { call, path } = await served(t);
  for (const query of ['?finished=omit', '?items=compact&finished=omit&since=1', '?items=compact&finished=other']) {
    const refused = await call(path + '/state' + query);
    assert.equal(refused.status, 400, query);
    assert.equal(refused.json.error.code, 'BAD_REQUEST');
  }
  assert.equal((await call(path + '/finished', {})).status, 400);
});
