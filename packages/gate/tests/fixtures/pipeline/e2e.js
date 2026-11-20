/**
 * End to end, one trivial item from claim to merged on a scratch project [C7]: claim, a queued submit, the real gate
 * pulled gate job, the receipt, review, accept and the landing batch, each hop's state change asserted on the
 * real board and timed. Run alone with `node packages/gate/tests/fixtures/pipeline/e2e.js`, or through `node packages/gate/src/io/matrix.js`.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  from,
  guardProcesses,
  hopCheck,
  waitUntil,
  within,
} from './kit.js';
import {
  handoffProject,
  json,
} from './project.js';

const { joinFixtureSeat } = await from('packages/gate/tests/fixtures/testkit.js');
const { gateSpanFolder, readGateSpans } = await from('packages/jobs/index.js');

/** The widest stretch of a gate no recorded phase may leave uncovered, on the local runner stand-in [C7]. */
const PHASE_GAP_MS = 10_000;

/** The board command latency target, per command, from Corey's 2 Nov speed rule. */
const COMMAND_TARGET_MS = 200;

let box;
guardProcesses({ before: () => { if (box) writeFileSync(box.release, 'release\n'); } });

/**
 * Run one CLI command and return its result with its wall time.
 *
 * @param {string} cwd
 * @param {...string} args
 * @returns {{ code: number, out: string, err: string, ms: number }}
 */
function timed(cwd, ...args) {
  const started = performance.now();
  const result = box.run(cwd, ...args);
  return { ...result, ms: performance.now() - started };
}

test('one item goes from claim to merged through every hop, each state change on the real board [C7]', { timeout: 300_000 }, async t => {
  box = handoffProject({ resident: true });
  const home = box.env.PULLBOARD_MACHINE_HOME;
  const id = box.item('Say hi through every hop');
  const latencies = [];

  await t.test('claim', () => hopCheck('claim', async () => {
    const claimed = timed(box.web, 'claim', String(id), '--json');
    json(claimed);
    const { item } = box.state(id);
    assert.equal(item.item_status, 'claimed');
    assert.equal(item.item_owner, 'web-1', 'the claim leases the item to the seat that asked');
    assert.match(item.item_frozen_digest ?? '', /^[0-9a-f]{64}$/u, 'the criterion froze at the claim');
    assert.ok(Date.parse(item.item_lease_until) > Date.now(), 'the claim holds a live lease');
    return { ms: claimed.ms, measured: `claimed by ${item.item_owner}, criterion frozen` };
  }));

  box.candidate(box.web, 'hold');
  let submittedAt;
  await t.test('submit-queued', () => hopCheck('submit-queued', async () => {
    const submitted = timed(box.web, 'submit', String(id), '--no-next', '--json');
    submittedAt = Date.now();
    const answer = json(submitted);
    assert.equal(answer.queued, true, 'submit hands the gate to the queue');
    const queuedJob = box.state(id).job;
    assert.ok(['queued', 'running'].includes(queuedJob?.state), `the hand-off is queued, not ${queuedJob?.state}`);
    assert.equal(queuedJob.commit, box.git(box.web, 'rev-parse', 'HEAD'), 'the queued job names the submitted commit');
    return { ms: submitted.ms, measured: `returned queued:true; job ${queuedJob.state}` };
  }));

  const running = await waitUntil(() => {
    const job = box.state(id).job;
    return job?.state === 'running' ? job : null;
  }, 'the gate job starts', 60_000, 150);

  writeFileSync(box.release, 'release\n');
  await t.test('test-receipt', () => hopCheck('test-receipt', async () => {
    const releasedAt = Date.now();
    const done = await waitUntil(() => {
      const seen = box.state(id);
      return ['green', 'submitted'].includes(seen.job?.state) && seen.item.item_status === 'submitted' ? seen : null;
    }, 'the gate finishes green and the item is submitted', 120_000, 150);
    const shown = json(timed(box.repo, 'show', String(id), '--json'));
    const receipts = shown.proofReceipts ?? [];
    assert.ok(receipts.length >= 1, 'the green gate left a proof receipt on the item');
    assert.ok(JSON.stringify(receipts).includes(done.item.item_commit), 'the receipt names the submitted commit');
    return { ms: Date.now() - releasedAt, measured: `release to green with ${receipts.length} receipt(s)` };
  }));

  await t.test('phase-gaps', () => hopCheck('phase-gaps', async () => {
    // Every moment of the gate belongs to a recorded phase: no stretch longer than PHASE_GAP_MS is covered by none.
    const spans = readGateSpans(gateSpanFolder(join(box.repo, '.git')), { since: submittedAt - 60_000, now: Date.now() + 60_000 })
      .filter(span => span.job === running.id && span.phase !== 'gate').sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    assert.ok(spans.some(span => span.phase === 'result'), 'the gate recorded its result span');
    let reach = Date.parse(spans[0].end), widest = { ms: 0, between: 'none' }, last = spans[0];
    for (const span of spans.slice(1)) {
      const gap = Date.parse(span.start) - reach;
      if (gap > widest.ms) widest = { ms: gap, between: `${last.phase} -> ${span.phase}` };
      if (Date.parse(span.end) > reach) { reach = Date.parse(span.end); last = span; }
    }
    within(widest.ms <= PHASE_GAP_MS, `no gap over ${PHASE_GAP_MS} ms between gate phases`, { ms: widest.ms, measured: `widest gap ${widest.ms} ms (${widest.between}) over ${spans.length} spans` });
    return { ms: widest.ms, measured: `widest gap ${widest.ms} ms (${widest.between}) over ${spans.length} spans` };
  }));

  await t.test('green-review', () => hopCheck('green-review', async () => {
    const shown = timed(box.repo, 'show', String(id));
    latencies.push(shown.ms);
    assert.match(shown.out, /submitted \(in review\)/u, 'a green gate puts the item in review');
    assert.match(shown.out, /waits independent reviewer/u);
    return { ms: shown.ms, measured: 'submitted (in review), waits independent reviewer' };
  }));

  await t.test('accept-merged', () => hopCheck('accept-merged', async () => {
    const started = Date.now();
    const review = join(box.dir, 'review');
    box.git(box.repo, 'worktree', 'add', '-q', '-b', 'api/review', review, 'main');
    json(joinFixtureSeat(box, review, 'api'));
    const commit = box.state(id).item.item_commit;
    box.git(review, 'switch', '-q', '--detach', commit);
    const verified = timed(review, 'verify', String(id), 'accept', '--note', 'removed web/snapshot.txt; the check still passed, so the bar is the snapshot', '--no-next');
    assert.equal(verified.code, 0, verified.err);
    assert.equal(box.state(id).item.item_verdict, 'ACCEPT');
    const landed = timed(box.repo, 'land');
    assert.equal(landed.code, 0, landed.err);
    const { item } = box.state(id);
    assert.ok(item.item_merged_commit, 'the landing recorded the merge commit');
    assert.equal(box.git(box.repo, 'rev-parse', 'main'), item.item_merged_commit, 'main moved to the recorded merge');
    assert.equal(box.git(box.repo, 'rev-parse', 'origin/main'), item.item_merged_commit, 'the landing pushed main');
    box.git(box.repo, 'merge-base', '--is-ancestor', commit, 'main');
    return { ms: Date.now() - started, measured: `accept ${Math.round(verified.ms)} ms, land ${Math.round(landed.ms)} ms; main at ${item.item_merged_commit.slice(0, 12)}` };
  }));

  await t.test('command-latency', () => hopCheck('command-latency', async () => {
    for (let run = 0; run < 5; run += 1) latencies.push(timed(box.repo, 'show', String(id), '--json').ms);
    for (let run = 0; run < 3; run += 1) latencies.push(timed(box.web, 'status').ms);
    const sorted = [...latencies].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length / 2)];
    const measured = { ms: p50, measured: `p50 ${Math.round(p50)} ms, max ${Math.round(sorted.at(-1))} ms over ${sorted.length} show and status calls` };
    within(p50 <= COMMAND_TARGET_MS, `board commands answer in ${COMMAND_TARGET_MS} ms; p50 was ${Math.round(p50)} ms`, measured);
    return measured;
  }));
});
