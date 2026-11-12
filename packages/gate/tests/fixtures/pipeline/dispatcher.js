/**
 * Repro, 8 Nov: a dispatcher started from submit-time tools kept launching gates on code main had since fixed, and one
 * gate opened 18 runner controllers. The invariant: once a gate is captured on newer tooling, the dispatcher on the
 * older tools copy stops launching and hands over to one on the current tooling, which launches that gate (DJ16) [C7].
 * Fails on 1989322098^ (the old dispatcher launches it); passes after 1989322098 and 244e394761.
 *
 * The project runs from a scratch copy of Pullboard, so the harness can move the tool root's HEAD; the checkout under
 * test is never touched.
 */
import assert from 'node:assert/strict';
import {
  appendFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import {
  basename,
  join,
} from 'node:path';
import { test } from 'node:test';
import {
  ROOT,
  committedCopy,
  gitIn,
  guardProcesses,
  hopCheck,
  scratch,
  survivors,
  track,
  waitUntil,
  within,
} from './kit.js';
import {
  dispatchers,
  json,
  mainTooling,
  projectKit,
} from './project.js';

/** A dispatcher checks its tooling every 30 s; the hand-over is due within one check and one pass after it. */
const HANDOVER_MS = 45_000;

/**
 * Whether two paths name the same folder, whichever of /var and /private/var each was spelled with.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function same(a, b) {
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
}

let box;
guardProcesses({ before: () => { if (box) writeFileSync(box.release, 'release\n'); } });

test('a dispatcher on an older tools copy hands over to one on the current tooling, which launches the new gate [C7]', { timeout: 400_000 }, async () => {
  const tools = committedCopy(ROOT, join(await scratch('stale-tools'), 'pullboard'));
  const { handoffProject } = await projectKit(tools);
  box = handoffProject({ handoffWorkers: 1 });
  const home = box.env.PULLBOARD_MACHINE_HOME;
  const first = box.item('Runs on the old tooling');
  const second = box.item('Captured on the new tooling');
  const seat = box.seat();
  json(box.run(box.web, 'claim', String(first), '--json'));
  json(box.run(seat, 'claim', String(second), '--json'));
  box.candidate(box.web, 'hold');
  box.candidate(seat, 'hold');
  json(box.run(box.web, 'submit', String(first), '--no-next', '--json'));
  await waitUntil(() => box.state(first).job?.state === 'running', 'the first gate runs', 120_000, 150);
  const old = dispatchers(home);
  assert.equal(old.length, 1, 'one dispatcher runs the first gate');
  assert.equal(basename(old[0].tools), `pullboard-handoff-tools-${mainTooling(tools)}`, 'it runs the tool root\'s committed tooling');

  // Main moves on: the tool root gets a tooling commit, so the next submit captures a newer tools snapshot.
  appendFileSync(join(tools, 'packages', 'drive', 'index.js'), `// hop harness tooling marker ${randomUUID()}\n`);
  gitIn(tools, 'commit', '-q', '-am', 'tooling moves on');
  const newTools = join(realpathSync(tmpdir()), `pullboard-handoff-tools-${mainTooling(tools)}`);
  track(newTools);

  await hopCheck('stale-dispatcher', async () => {
    json(box.run(seat, 'submit', String(second), '--no-next', '--json'));
    const queuedAt = Date.now();
    assert.equal(box.state(second).job.state, 'queued', 'with one worker the new gate waits behind the old one');
    let successor;
    try {
      successor = await waitUntil(() => dispatchers(home).find(entry => entry.tools !== old[0].tools), 'a dispatcher on the current tooling', HANDOVER_MS, 250);
    } catch (error) {
      within(false, `a dispatcher on the current tooling started within ${HANDOVER_MS} ms`, { ms: Date.now() - queuedAt, measured: `no hand-over in ${HANDOVER_MS / 1000} s; still on ${basename(old[0].tools).slice(-12)}` });
      throw error;
    }
    const ms = Date.now() - queuedAt;
    within(same(successor.tools, newTools), 'the successor runs the snapshot the new gate was captured on',
      { ms, measured: `successor on ${basename(successor.tools)}, expected ${basename(newTools)}` });
    writeFileSync(box.release, 'release\n');
    const launched = await waitUntil(() => {
      const job = box.state(second).job;
      const pid = job?.state === 'running' ? box.driver(job.id)?.pid : null;
      return pid ? survivors([box.dir]).find(entry => entry.pid === pid) : null;
    }, 'the new gate\'s driver starts', 180_000, 200);
    const measured = { ms, measured: `hand-over ${Math.round(ms / 100) / 10} s after the newer capture; new gate driven from ${launched.command.includes(basename(newTools)) ? 'the current tooling' : 'the old tooling'}` };
    within(launched.command.includes(newTools) || launched.command.includes(newTools.replace(/^\/private\//u, '/')), 'the gate captured on newer tooling is driven from that tooling', measured);
    await waitUntil(() => !survivors([home]).some(entry => entry.pid === old[0].pid), 'the old dispatcher exits once its own gate ends', 120_000, 250);
    return measured;
  });

  await waitUntil(() => box.state(second).item.item_status === 'submitted', 'the new gate finishes', 180_000, 250);
});
