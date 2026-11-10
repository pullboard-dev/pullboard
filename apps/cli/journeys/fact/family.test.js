import { viewApiPorts } from '../../../view/index.js';
/** The public agents payload names the same canonical vendor as native eligibility [A1,V4,B26]. */
import { apiBoardOpeners } from '../../tests/fixtures/board.js';

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { apiFetch } from '../../tests/fixtures/api.js';
import { serveApi } from '../../../../packages/api/index.js';
import { refusalDocument } from '../../index.js';
import { main } from '../../tests/fixtures/native.js';
import { openBoard } from '../../../lib/index.js';
import * as store from '../../../../packages/store/index.js';
import { seatFamily } from '../../../../packages/items/index.js';
import { FAMILY_DECLARE_ENGINE } from '../../../../packages/state/light.js';

test('agents API returns canonical declared and historically derived families [A1,V4,B26]', async t => {
  const helpers = createE2eHelpers();
  let api;
  t.after(async () => { try { await api?.close(); } finally { helpers.cleanup(); } });
  const box = helpers.project('true');
  // @pullboard-board-file journey: seed a real board before the authenticated API opens its own read connection.
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  let declared, derived, unknown;
  const expected = new Map();
  try {
    declared = store.register(board, { lane: 'web', path: join(box.dir, 'declared'), family: 'OpenAI', model: 'Synthetic declared fixture' });
    const historical = { lane: 'web', path: join(box.dir, 'historical'), family: 'Claude', model: 'Synthetic historical fixture' };
    derived = store.register(board, historical);
    board.executionEngineVersion = FAMILY_DECLARE_ENGINE - 1;
    try { store.register(board, { ...historical, family: null }); }
    finally { delete board.executionEngineVersion; }
    unknown = store.register(board, { lane: 'web', path: join(box.dir, 'unknown'), model: 'Synthetic unknown fixture' });
    assert.equal(board.db.prepare('SELECT agent_family FROM agent WHERE agent_id=?').get(derived).agent_family, null,
      'the historical fixture really has a cleared stored column');
    for (const id of [declared, derived, unknown]) expected.set(id, seatFamily(board, id));
    assert.deepEqual([...expected.values()], ['OpenAI', 'Claude', null], 'ordered declarations retain their canonical vendor after a historical clear');
  } finally { store.closeBoard(board); }
  api = await serveApi({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, runCommand: main, projects: () => [{ root: box.repo, name: 'Family fixture' }] });
  const url = new URL(api.url), connection = { origin: url.origin, secret: url.searchParams.get('k') };
  const listed = await apiFetch(connection, '/api/v1/boards');
  assert.equal(listed.status, 200);
  const document = await listed.json();
  const id = document.boards.find(row => row.root === box.repo)?.id;
  assert.ok(id, 'the actual native board is exposed by the authenticated API');
  const response = await apiFetch(connection, `/api/v1/boards/${id}/state`);
  assert.equal(response.status, 200);
  const { state } = await response.json();
  for (const [agentId, family] of expected) {
    const agent = state.agents.find(row => row.agent_id === agentId);
    assert.ok(agent, `the API includes ${agentId}`);
    assert.equal(agent.family, family, `${agentId} exposes the exact seatFamily value, including explicit unknown`);
  }
});
