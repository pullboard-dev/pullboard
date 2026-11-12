// fixture-subject: addItem
/** @pullboard-test-gui */
import { viewApiPorts } from '../../../view/index.js';
/** An idle view tab never rebuilds the board state because an item's idle minute ticked over [C7]. */
import { apiBoardOpeners } from '../../tests/fixtures/board.js';

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { boardId } from '../../../../packages/store/index.js';
import { closeBoard } from '../../../../packages/store/index.js';
import { exportBoard } from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { serveApi } from '../../../../packages/api/index.js';
import { refusalDocument } from '../../index.js';
import { main } from '../../tests/fixtures/native.js';
import {
  machine,
  project,
} from '../../tests/fixtures/cockpit/harness.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';

/** One real HTTP server over a three-item board with every baseline check finished, and a clock the test moves. */
async function idleFixture(t) {
  const box = machine(), alpha = project(box, 'idle-cost');
  for (const title of ['First idle-cost item', 'Second idle-cost item', 'Third idle-cost item']) {
    fileFixtureItem(box, alpha.repo, { lane: 'web', title, criterion: 'The private project configuration exists.', check: 'test -f pullboard.json', args: ['--specs', 'G1'], wait: true,
      run: (root, ...args) => ({ code: 0, out: box.run(root, ...args), err: '' }) });
  }
  const base = Date.now() + 1_000, clock = { at: base };
  // @pullboard-board-file journey: the CLI seeds the persisted Git-local board that serveApi reopens over HTTP.
  const board = openBoard(join(alpha.repo, '.git', 'pullboard', 'board.sqlite'), { now: () => new Date(base) });
  t.after(() => closeBoard(board));
  const id = boardId(board), secret = randomBytes(24).toString('base64url');
  let builds = 0;
  const api = await serveApi({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, secret, runCommand: main, projects: () => [{ root: alpha.repo, name: 'idle-cost' }],
    scope: { projectRoot: alpha.repo }, isMain: true, now: () => clock.at, onStateBuild: () => { builds++; } });
  t.after(api.close);
  const get = async path => {
    const response = await fetch(`http://127.0.0.1:${api.port}/api/v1/boards/${id}/${path}`, { headers: { 'x-pullboard-key': secret } });
    assert.equal(response.status, 200, path);
    return response.json();
  };
  return { base, clock, board, get, api, id, secret, builds: () => builds, original: exportBoard(board) };
}

// Native CLI setup and two minutes of one-second polls over a real HTTP server share this journey budget.
test('clause 1: an idle tab polling for two minutes causes no state rebuild and item idle time still advances [C7]', { timeout: 90_000 }, async t => {
  const { base, clock, board, get, builds, original } = await idleFixture(t);
  /** Each item's idle minutes must equal the clock minus its own last activity. */
  const idle = async () => (await get('state')).state.items.map(item => [item.progress.idleMinutes,
    Math.max(0, Math.floor((clock.at - Date.parse(item.progress.lastActivity)) / 60_000))]);
  const first = await idle();
  assert.ok(first.every(([reported, expected]) => reported === expected));
  const warm = builds();
  assert.ok(warm >= 1);
  for (let second = 1; second <= 120; second++) { clock.at = base + second * 1000; await get('state'); }
  assert.equal(builds(), warm, 'a board with no writes keeps one build however many item idle minutes pass');
  const later = await idle();
  assert.equal(builds(), warm);
  assert.ok(later.every(([reported, expected]) => reported === expected), 'item idle time follows the clock without a rebuild');
  assert.ok(later.some(([reported], index) => reported > first[index][0]), 'two minutes of polling moved at least one idle reading');
  assert.deepEqual(exportBoard(board), original, 'polling never manufactures a native move');
  // The measured half of the clause: a tab polls once a second, so 30 polls are a 30 s window; server and client share this process, so their combined CPU bounds the server's.
  const cpuBefore = process.cpuUsage();
  for (let second = 1; second <= 30; second++) { clock.at = base + (120 + second) * 1000; await get('state'); }
  const cpu = process.cpuUsage(cpuBefore);
  const percent = (cpu.user + cpu.system) / 1000 / 30_000 * 100;
  assert.ok(percent < 5, `one idle tab uses ${percent.toFixed(2)}% of one core over 30 s; the ceiling is 5%`); // budget: ceiling declared by the item criterion, under 5% of one core over 30 s.
  assert.equal(builds(), warm, 'the 30 s window rebuilt nothing');
});

test('clause 3: an item request is answered while another tab\'s state request is still outstanding, and tab switches wait behind no rebuild [C7]', { timeout: 90_000 }, async t => {
  const { base, clock, get, builds, api, id, secret } = await idleFixture(t);
  await get('state');
  const warm = builds();
  clock.at = base + 90_000;
  const started = performance.now();
  const panel = await get('items/1');
  assert.ok(performance.now() - started < 100, 'an item panel answers from the warm build'); // budget: ceiling declared by the item criterion, an item panel under 100 ms.
  assert.ok(panel);
  // A deliberately held state request: another tab sent it and has not read the reply, so it stays outstanding on the socket.
  const held = await fetch(`http://127.0.0.1:${api.port}/api/v1/boards/${id}/state`, { headers: { 'x-pullboard-key': secret } });
  assert.equal(held.status, 200);
  const alongside = performance.now();
  assert.ok(await get('items/2'), 'an item answers while the held state reply is unread');
  assert.ok(performance.now() - alongside < 100, 'an item request waits on no outstanding state request'); // budget: ceiling declared by the item criterion, under 100 ms.
  await held.json();
  const tabs = await Promise.all([get('state'), get('items/2'), get('items/3'), get('state')]);
  assert.equal(tabs.length, 4);
  assert.equal(builds(), warm, 'a minute and a half later the tabs still share the one build');
});
