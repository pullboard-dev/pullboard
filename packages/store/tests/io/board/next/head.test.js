/** next never offers a build for an open item whose latest head already has a gate [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordSubmitHandoff } from '../../../../../jobs/index.js';
import { addItem } from '../../../../index.js';
import { nextFor } from '../../../../index.js';
import { fixtureBoard } from '../../../../../../apps/cli/tests/fixtures/board.js';

const HEAD = 'a'.repeat(40);

/** Record a queue observation for an item the way the submit queue does, with no worker running. */
function observe(board, id, job, head = HEAD) {
  board.db.prepare('UPDATE item SET item_commit = ? WHERE item_id = ?').run(head, id);
  recordSubmitHandoff(board.db, id, { id: `fixture-${id}`, commit: HEAD, agentId: 'web-1', ...job });
}

test('nextFor skips an open item whose gate is queued, running, green or infra-exhausted at its head, and offers a red one [C7, #2881]', t => {
  const board = fixtureBoard(t);
  const make = title => addItem(board, { by: 'coordinator', lane: 'web', title });
  const cases = [
    [make('queued'), { state: 'queued' }, 'queued'],
    [make('running'), { state: 'running' }, 'running'],
    [make('green'), { state: 'green' }, 'green'],
    [make('exhausted'), { state: 'infrastructure', error: { code: 'GATE_INFRA_EXHAUSTED' } }, 'GATE_INFRA_EXHAUSTED'],
  ];
  for (const [id, job] of cases) observe(board, id, job);
  const reasons = nextFor(board, { agentId: 'web-2', lane: 'web' }).reasons;
  for (const [id, , label] of cases) {
    assert.ok(reasons.includes(`#${id}: gate ${label} at ${HEAD.slice(0, 12)}; nothing to build`), `${id}: ${reasons.join(' | ')}`);
  }
  assert.equal(nextFor(board, { agentId: 'web-2', lane: 'web' }).item, null);

  const red = make('red');
  observe(board, red, { state: 'red', error: { code: 'TEST_FAILURE' } });
  assert.equal(nextFor(board, { agentId: 'web-2', lane: 'web' }).item.item_id, red, 'a red gate still offers the item');
});

test('a gate left from an older head never hides an item whose head moved on [C7, #2881]', t => {
  const board = fixtureBoard(t);
  const id = addItem(board, { by: 'coordinator', lane: 'web', title: 'moved head' });
  observe(board, id, { state: 'green' }, 'b'.repeat(40));
  const reasons = nextFor(board, { agentId: 'web-2', lane: 'web' });
  assert.equal(reasons.item?.item_id, id, `a green job at another head still offers the item: ${reasons.reasons.join(' | ')}`);
});
