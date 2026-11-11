/** @pullboard-world-pin: clause 1 reads the four named test files themselves to prove none imports a shim. */
/** @pullboard-test-gui */
import { viewApiPorts } from '../../../view/index.js';
/** A real cached native HTTP board refreshes Dashboard pace even when it has no milestone [N26,A2]. */
import { apiBoardOpeners } from '../../tests/fixtures/board.js';

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { serveApi } from '../../../../packages/api/index.js';
import { refusalDocument } from '../../index.js';
import { main } from '../../tests/fixtures/native.js';
import { exportBoard } from '../../../../packages/store/index.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import {
  machine,
  project,
} from '../../tests/fixtures/cockpit/harness.js';

/** Clause 1 proof: the four view-lane tests take their bindings from the cli front door, not the shims. */
test('clause 1: the four view-lane tests import nothing from a top-level src file, so no shim [N26]', () => {
  for (const file of ['clock.test.js', '../relay/signin.test.js', '../../tests/fixtures/cockpit/lifecycle/seed/ordinary.js', '../shout/prose.test.js']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /(?:\.\.\/)+src\/[\w-]+\.js['"]/, `${file} still imports a top-level src file`);
  }
});

/** Clause 2 proof: every binding the four view-lane tests take from the cli front door resolves. */
test('clause 2: the cli front door exports every binding the four view-lane tests take from it [N26]', async () => {
  const front = await import('../../index.js');
  for (const name of ['refusalDocument', 'cli$HELP', 'cli$freezer', 'cli$main']) {
    assert.ok(front[name], `apps/cli/index.js does not export ${name}`);
  }
});

// Native CLI setup, three real HTTP cache windows and owned server cleanup share this journey budget.
test('Dashboard pace crosses every cached window without a milestone or a native write [N26,A2]', { timeout: 90_000 }, async t => {
  const box = machine(), alpha = project(box, 'dashboard-clock');
  box.run(alpha.repo, 'add', 'web', 'A recorded landing for the clock fixture', '--specs', 'G1',
    '--criterion', 'The private project configuration exists.', '--check', 'test -d web/', '--wait');
  const base = Date.now() + 1_000, clock = { at: base };
  // @pullboard-board-file journey: the CLI seeds the persisted Git-local board that serveApi reopens over HTTP.
  const board = openBoard(join(alpha.repo, '.git', 'pullboard', 'board.sqlite'), { now: () => new Date(base) });
  t.after(() => store.closeBoard(board));
  const reviewer = store.register(board, { lane: 'tests', path: join(box.dir, 'clock-reviewer'), parentDigest: 'b'.repeat(64) });
  const head = box.git(alpha.repo, 'rev-parse', 'HEAD'), tree = box.git(alpha.repo, 'rev-parse', 'HEAD^{tree}');
  // These ordinary native lifecycle inputs model a landed item, not gate or independent-review evidence.
  const frozen = { text: '{"rows":[]}', digest: 'dashboard-clock-synthetic-acceptance' };
  store.claim(board, 1, { agentId: 'web-1', lane: 'web', leaseMs: 3_600_000, head, freeze: () => frozen });
  submitFixture(board, 1, { agentId: 'web-1', commit: head, tree });
  store.reserveReview(board, 1, { agentId: reviewer, leaseMs: 3_600_000, policy: 'any' });
  store.verify(board, 1, { agentId: reviewer, decision: 'ACCEPT', head, digest: frozen.digest,
    policy: 'any', familyPolicy: 'off', note: 'Synthetic state projection fixture, not review assurance.',
    review: { commit: head, head, trunk: head, paths: [] } });
  store.merged(board, 1, { agentId: 'coordinator', commit: head });
  const id = store.boardId(board), secret = randomBytes(24).toString('base64url');
  let builds = 0;
  const api = await serveApi({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, secret, runCommand: main, projects: () => [{ root: alpha.repo, name: 'dashboard-clock' }],
    scope: { projectRoot: alpha.repo }, isMain: true, now: () => clock.at, onStateBuild: () => { builds++; } });
  t.after(api.close);
  const original = exportBoard(board);
  /** Read the actual summary endpoint twice in a stable window, then across its exact boundary. */
  async function read(offset) {
    clock.at = base + offset;
    const response = await fetch(`http://127.0.0.1:${api.port}/api/v1/boards/${id}/state`, { headers: { 'x-pullboard-key': secret } });
    assert.equal(response.status, 200);
    return (await response.json()).state;
  }
  const hour = 3_600_000;
  const first = await read(2 * hour - 2);
  assert.deepEqual(first.milestones, []);
  assert.deepEqual(first.dashboardPace, { last2h: 1, last6h: 1, last24h: 1 });
  const warm = builds;
  await read(2 * hour - 1);
  assert.equal(builds, warm, 'an unchanged clock window uses the native cache');
  assert.equal((await read(2 * hour)).dashboardPace.last2h, 0, 'the exact strict two-hour boundary expires without a milestone');
  assert.equal((await read(6 * hour)).dashboardPace.last6h, 0);
  assert.equal((await read(24 * hour)).dashboardPace.last24h, 0);
  assert.deepEqual(exportBoard(board), original, 'HTTP clock refresh never manufactures a native move');
});
