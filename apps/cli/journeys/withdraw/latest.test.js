/** A held state record reports the current clock when the board revision is unchanged [A2,C7,N26]. */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { viewApiPorts } from '../../../view/index.js';
import { refusalDocument } from '../../index.js';
import { serveApi } from '../../../../packages/api/index.js';
import { apiBoardOpeners } from '../../tests/fixtures/board.js';
import { apiHttpFixture } from '../../tests/fixtures/api.js';
import { main } from '../../tests/fixtures/native.js';

const STATE_PORTS = new URL('../../src/io/commands/serve.js', import.meta.url).href;

test('[A2,C7,N26] a read of an unchanged board reports a newer flow asOf, with the same content and no new build', async (t) => {
  const box = apiHttpFixture(t);
  box.cli(box.root, 'add', 'app', 'Latest item', '--route', 'strong', '--criterion', 'Detail', '--brief', 'Files:\n- app/latest.js\nChange:\n- Keep it.\nTest:\n- It reads.');
  const builds = [];
  const api = await serveApi({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, runCommand: main, statePorts: STATE_PORTS,
    onStateBuild: (build) => builds.push(build), projects: () => [{ root: box.root, name: 'Latest fixture' }] });
  t.after(() => api.close());
  const url = new URL(api.url);
  const headers = { 'x-pullboard-key': url.searchParams.get('k') };
  const id = (await (await fetch(url.origin + '/api/v1/boards', { headers })).json()).boards[0].id;
  /** One state read's document. */
  const read = async () => (await (await fetch(`${url.origin}/api/v1/boards/${id}/state?items=compact`, { headers })).json()).state;

  const first = await read();
  const built = builds.length;
  assert.ok(built >= 1, 'the first read waits on a build');
  let previous = first;
  for (let index = 1; index <= 3; index += 1) {
    let next = await read();
    // The clock reads in milliseconds: a read that lands in the same one as the last is read again until it moves on.
    for (let again = 0; again < 200 && next.proofStats.flow.asOf <= previous.proofStats.flow.asOf; again += 1) next = await read();
    assert.ok(next.proofStats.flow.asOf > previous.proofStats.flow.asOf, `read ${index} reports a newer asOf than the one before: ${previous.proofStats.flow.asOf} then ${next.proofStats.flow.asOf}`);
    if (next.statsComparison?.available) assert.equal(next.statsComparison.current.until, next.observedAt, `read ${index} ends its comparison window at its own observedAt`);
    assert.equal(next.sequence, first.sequence, `read ${index} holds the same board content`);
    assert.deepEqual(next.items, first.items, `read ${index} holds the same items`);
    previous = next;
  }
  // A restamp is a slice of held text, not a build or a worker round trip: warm reads of the unchanged board stay quick.
  const times = [];
  for (let index = 0; index < 20; index += 1) { const started = performance.now(); await read(); times.push(performance.now() - started); }
  times.sort((left, right) => left - right);
  t.diagnostic(`warm unchanged read over HTTP: median ${times[10].toFixed(1)} ms, slowest ${times[19].toFixed(1)} ms`);
  assert.ok(times[10] < 25, `a warm read of an unchanged board is served in ${times[10].toFixed(1)} ms (median), under 25 ms`);
  assert.equal(builds.length, built, 'reads of an unchanged board start no rebuild of the board');
});
