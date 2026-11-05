/** Counterfactual replay drives actual registered wake executables through native review reservation [C7,#3076]. */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import * as store from '../packages/store/index.js';
import { repoInfo } from '../packages/git/index.js';
import { registerSeatWake } from '../packages/seats/index.js';
import { wakeReviewCapacity } from '../packages/sentinels/index.js';
import { submitFixture } from './board-submit-fixture.js';
import { fixture } from './next-take-fixture.js';

/** Make one explicitly synthetic replay seat; labels do not claim an actual model runtime is running. */
function replaySeat(box, name, family, { clockFile, wakeLog } = {}) {
  const path = join(box.root, '..', `replay-${name}`);
  box.git(box.root, 'worktree', 'add', '-q', '--detach', path, 'HEAD');
  const id = store.register(box.board, { lane: 'web', path, parent: `replay-parent-${name}`,
    model: `${name} counterfactual fixture`, family, route: 'strong' });
  if (clockFile) {
    const executable = join(box.root, '..', `replay-${name}-wake.mjs`);
    const mainUrl = new URL('./native-cli-fixture.js', import.meta.url).href;
    writeFileSync(executable, `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
import { main } from ${JSON.stringify(mainUrl)};
const at = readFileSync(${JSON.stringify(clockFile)}, 'utf8').trim();
let out = '', err = '';
const command = ['next', '--verify', process.argv[2], '--json'];
const code = await main(command, { cwd: ${JSON.stringify(path)}, clock: { now: () => new Date(at) },
  stdout: { isTTY: false, write: text => { out += text; } }, stderr: { write: text => { err += text; } } });
let result;
try { result = JSON.parse(out); } catch { result = { output: out }; }
appendFileSync(${JSON.stringify(wakeLog)}, JSON.stringify({ fixture: ${JSON.stringify(name)}, at, command, code, result, err }) + String.fromCharCode(10));
process.exitCode = code;
`);
    chmodSync(executable, 0o755);
    registerSeatWake(repoInfo(path), store.boardId(box.board), id, executable);
  }
  return { id, path, lane: 'web' };
}

test('recorded Nov3 green submissions get an automatic independent wake reservation within fifteen replay minutes [C7,#3076]', async t => {
  const trace = JSON.parse(readFileSync(new URL('./review-family-cover-replay.json', import.meta.url), 'utf8'));
  assert.equal(trace.submissions.length, 23);
  const box = await fixture(t, { family: 'require' });
  const start = Date.parse(trace.start), end = Date.parse(trace.end);
  box.advance(start - 11 * 60_000 - box.clock.now().getTime());
  const clockFile = join(box.root, '..', 'replay-clock');
  const wakeLog = join(box.root, '..', 'replay-wakes.jsonl');
  const builder = replaySeat(box, 'OpenAI-builder', 'OpenAI');
  const haiku = replaySeat(box, 'Haiku', 'Anthropic', { clockFile, wakeLog });
  const luna = replaySeat(box, 'Luna', 'OpenAI', { clockFile, wakeLog });
  const info = repoInfo(box.root);
  const head = box.git(builder.path, 'rev-parse', 'HEAD');
  const tree = box.git(box.root, 'rev-parse', `${head}^{tree}`);
  const timeline = trace.submissions.map(([offset, family], index) => ({ at: start + offset, family, index }));
  // The native background coordinator normally sweeps every ten minutes; its queue threshold is five.
  for (let at = start; at <= end; at += 10 * 60_000) timeline.push({ at, sweep: true });
  timeline.sort((a, b) => a.at - b.at || Number(Boolean(a.sweep)) - Number(Boolean(b.sweep)));
  const ctx = { info, config: box.config, clock: box.clock };
  /** Only normal native facts and shouts are emitted by this private coordinator sweep. */
  const ordered = async (_ctx, board, operation, args) => store[operation](board, ...args);
  let firstId, firstSubmittedAt;
  const wallStarted = performance.now();
  for (const event of timeline) {
    box.advance(event.at - box.clock.now().getTime());
    writeFileSync(clockFile, box.clock.now().toISOString());
    if (event.sweep) { await wakeReviewCapacity(ctx, box.board, ordered); continue; }
    assert.equal(event.family, 'openai', 'the historical immutable submit-author vendor is retained');
    const id = box.add(`Recorded green submission ${event.index}`, { route: 'strong' });
    box.claim(id, builder);
    // Synthetic state represents the recorded green input; it is never offered as a gate execution receipt.
    submitFixture(box.board, id, { agentId: builder.id, commit: head, tree, gateGreen: true });
    if (firstId === undefined) {
      firstId = id; firstSubmittedAt = event.at;
      assert.throws(() => store.reserveReview(box.board, id, { agentId: luna.id,
        leaseMs: 30 * 60_000, policy: 'any', familyPolicy: 'require' }), error => ['SAME_FAMILY', 'O2_FAMILY_MATCH'].includes(error.code));
    }
  }
  const wakes = existsSync(wakeLog) ? readFileSync(wakeLog, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  assert.ok(wakes.length, 'an actual registered executable ran');
  const first = wakes.find(row => row.code === 0 && row.result.item?.item_id === firstId);
  assert.ok(first, JSON.stringify(wakes));
  assert.equal(first.fixture, 'Haiku', 'the other vendor receives the OpenAI submission');
  assert.deepEqual(first.command, ['next', '--verify', String(firstId), '--json']);
  const reservation = store.events(box.board, { itemId: firstId }).find(event => event.event_kind === 'reserve');
  assert.equal(reservation?.event_by, haiku.id, 'native CLI automatically recorded the independent reservation');
  const elapsedMs = Date.parse(reservation.event_at) - firstSubmittedAt;
  assert.ok(elapsedMs >= 0 && elapsedMs <= 15 * 60_000, `${elapsedMs} replay milliseconds until first reservation`); // budget: declared3076 fifteen-minute replay promise, not model-runtime latency.
  assert.equal(wakes.some(row => row.fixture === 'Luna'), false, 'same-family routing stays excluded');
  t.diagnostic(JSON.stringify({ kind: 'counterfactual-native-wake-replay', window: [trace.start, trace.end],
    submissions: trace.submissions.length, firstGreenAt: new Date(firstSubmittedAt).toISOString(),
    firstReservationAt: reservation.event_at, elapsedReplayMs: elapsedMs, executionWallMs: performance.now() - wallStarted,
    assumptions: 'recorded green times/vendors; fixture Haiku/Luna wake capabilities; ten-minute sweeps; injected replay clock; no real model-runtime latency claim' }));
});
