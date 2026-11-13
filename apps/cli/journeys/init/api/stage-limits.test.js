/** The board state served over HTTP carries each stage's time limit from the board's settings, and leaves out a stage with no setting [#6940]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { viewApiPorts } from '../../../../view/index.js';
import { apiHttpFixture } from '../../../tests/fixtures/api.js';
import { apiBoardOpeners } from '../../../tests/fixtures/board.js';
import { main } from '../../../tests/fixtures/native.js';
import { refusalDocument } from '../../../index.js';
import { fetchFresh } from '../../../tests/fixtures/http.js';
import { serveApi } from '../../../../../packages/api/index.js';

/** Serve one private board, and read its state over HTTP. */
async function stateOf(t, box, api) {
  const url = new URL(api.url);
  const listed = await (await fetchFresh(url.origin + '/api/v1/boards', { headers: { 'x-pullboard-key': url.searchParams.get('k') } })).json();
  const response = await fetchFresh(url.origin + '/api/v1/boards/' + listed.boards[0].id + '/state', { headers: { 'x-pullboard-key': url.searchParams.get('k') } });
  return JSON.parse(await response.text()).state;
}

test('[A2] clause 1 and clause 2: GET /state carries stageLimits read from the board settings, and a stage with no setting is absent [#6940]', async (t) => {
  const box = apiHttpFixture(t);
  const file = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, itemBuildBudgetMinutes: 17, review: { ...config.review, starveMinutes: 8 }, check: { ...config.check, timeout: '9m' } }));
  const api = await serveApi({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, runCommand: main, projects: () => [{ root: box.root, name: 'HTTP fixture' }] });
  t.after(() => api.close());
  const limits = (await stateOf(t, box, api)).stageLimits;
  assert.equal(limits.building, 17);
  assert.equal(limits['pending review'], 8);
  assert.equal(limits.gate, 9);
  assert.equal(Object.hasOwn(limits, 'landing'), false, 'no landing.timeout, no landing limit');
  assert.equal(Object.hasOwn(limits, 'ready'), false);
});
