/** Automatic landing adopts a batch whose landing process is gone, and leaves a live one alone [B35,B3,R3]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { onBoard } from '../../../tests/fixtures/land/board.js';
import { joinFixtureSeat } from '../../../tests/fixtures/testkit.js';
import * as store from '../../../../../packages/store/index.js';
import { landingHost } from '../../../../../packages/landing/index.js';
import { landingProcessLive } from '../../../../../packages/landing/index.js';

/** Run a successful JSON command in-process and parse its answer. */
async function json(box, cwd, ...args) {
  const result = await box.runLocal(cwd, ...args, '--json');
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  return JSON.parse(result.out);
}

/** Commit fixture source through the installed ordinary hooks. */
function commit(box, root, message) {
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', message);
  return box.git(root, 'rev-parse', 'HEAD');
}

/** Build, submit and accept one web item from main, returning the verify run. */
async function acceptItem(box, reviewer, file, title) {
  box.git(box.web, 'reset', '-q', '--hard', 'main');
  const id = (await json(box, box.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', `${file} exists`, '--route', 'strong', '--check', `test -f web/${file}`)).item.item_id;
  await json(box, box.web, 'claim', String(id));
  writeFileSync(join(box.web, 'web', file), `${title}\n`);
  const head = commit(box, box.web, `feat(web): ${title.toLowerCase()} [G1]`);
  await json(box, box.web, 'submit', String(id));
  box.git(reviewer, 'checkout', '-q', '--detach', head);
  return { id, head, verify: await box.runLocal(reviewer, 'verify', String(id), 'accept', '--note', `The frozen ${file} check passed.`) };
}

/** Accept item A while a person holds landing, then return landing to the board so A waits on trunk. */
async function waitingItem(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const config = { ...helpers.CONFIG, gate: 'true', landing: { perItem: false, publish: 'separate', manualOverride: true } };
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config));
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/base.txt'), 'base\n');
  commit(box, box.repo, 'chore: configure held landing');
  const reviewer = join(box.dir, 'reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, 'main');
  assert.equal((await joinFixtureSeat(box, reviewer, 'api', { run: box.runLocal })).code, 0, 'the reviewer joins on the strong route the items need');
  const first = await acceptItem(box, reviewer, 'first.txt', 'First result');
  assert.equal(first.verify.code, 0, first.verify.out + first.verify.err);
  config.landing.manualOverride = false;
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config));
  const trunk = commit(box, box.repo, 'chore: return landing to the board');
  return { box, reviewer, first, trunk };
}

/** Record an unfinished merging batch, as a crashed landing leaves it; `worktree: false` loses its worktree. */
function stuckBatch(box, { base, items, pid, worktree = true, state = 'merging' }) {
  const id = randomUUID();
  const directory = join(box.repo, '.git', 'pullboard', 'landings', id);
  const root = join(directory, 'worktree');
  if (worktree) {
    mkdirSync(directory, { recursive: true });
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', root, base);
  }
  return onBoard(box, board => store.recordLandingBatch(board, { agentId: 'coordinator', batch: {
    version: 1, id, startedAt: new Date().toISOString(), base, tip: base, branch: 'refs/heads/main', root,
    candidates: items, items, conflicts: [], blocked: [], state, owner: 'crashed-landing-session',
    pid, host: landingHost(), logPath: join(directory, 'logs', 'batch.log'), revision: 0 } }));
}

/** A process id that existed and has exited; a real exited child is process-level, so this launch stays. */
function deadPid() {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

/** Read one recorded batch by id. */
function batchById(box, id) {
  return onBoard(box, board => store.landingBatches(board).find(batch => batch.id === id));
}

test('an adopted dead worker batch persists the dead pid and the gap on the batch [C7,#2912]', async t => {
  const { box, reviewer, first, trunk } = await waitingItem(t);
  const stuck = stuckBatch(box, { base: trunk, items: [{ id: first.id, commit: first.head }], pid: deadPid() });
  const note = { pid: stuck.pid, gapSeconds: 97, at: new Date().toISOString() };
  box.env.PULLBOARD_LANDING_ADOPTION = JSON.stringify(note);
  try {
    const second = await acceptItem(box, reviewer, 'second.txt', 'Second result');
    assert.equal(second.verify.code, 0, second.verify.out + second.verify.err);
  } finally { delete box.env.PULLBOARD_LANDING_ADOPTION; }
  const resumed = batchById(box, stuck.id);
  assert.deepEqual(resumed.adoptedFrom, note, 'the stored batch names the dead pid and the gap in seconds');
});

test('a gating batch whose worker died before its gate log existed resumes and lands [B35,B3,C7,#3013]', async t => {
  const { box, reviewer, first, trunk } = await waitingItem(t);
  const stuck = stuckBatch(box, { base: trunk, items: [{ id: first.id, commit: first.head }], pid: deadPid(), state: 'gating' });
  assert.equal(existsSync(stuck.logPath), false, 'the gate log was never written');
  const second = await acceptItem(box, reviewer, 'second.txt', 'Second result');
  assert.equal(second.verify.code, 0, second.verify.out + second.verify.err);
  const resumed = batchById(box, stuck.id);
  assert.equal(resumed.state, 'landed', 'the interrupted gating batch itself resumes');
  assert.equal(resumed.refusal ?? null, null, 'it is never blocked LAND_WORKTREE');
  assert.ok((await json(box, box.repo, 'show', String(first.id))).item_merged_commit, 'the waiting item lands without a person');
});

test('an interrupted batch whose worktree is gone is blocked and a fresh batch lands both items [B35,B3,R3]', async t => {
  const { box, reviewer, first, trunk } = await waitingItem(t);
  const stuck = stuckBatch(box, { base: trunk, items: [{ id: first.id, commit: first.head }], pid: deadPid(), worktree: false });
  assert.equal(existsSync(stuck.root), false);
  const second = await acceptItem(box, reviewer, 'second.txt', 'Second result');
  assert.equal(second.verify.code, 0, second.verify.out + second.verify.err);
  const blocked = batchById(box, stuck.id);
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.refusal.code, 'LAND_WORKTREE');
  // Landing is per item (#2901): the waiting item lands in a fresh batch of its own, then the new accept in the next.
  const freshBatches = onBoard(box, board => store.landingBatches(board).filter(batch => batch.id !== stuck.id && batch.state === 'landed'));
  assert.deepEqual(freshBatches.flatMap(batch => batch.items.map(entry => entry.id)).sort((a, b) => a - b), [first.id, second.id]);
  for (const id of [first.id, second.id]) assert.ok((await json(box, box.repo, 'show', String(id))).item_merged_commit, `#${id} lands`);
  assert.equal(readFileSync(join(box.repo, 'web/second.txt'), 'utf8'), 'Second result\n');
});

test('a batch whose landing process is still live is left alone [B35,B3]', async t => {
  const { box, reviewer, first, trunk } = await waitingItem(t);
  const stuck = stuckBatch(box, { base: trunk, items: [{ id: first.id, commit: first.head }], pid: process.ppid }); // the parent is a live process other than this in-process adopter, whose own pid never counts as live
  const second = await acceptItem(box, reviewer, 'second.txt', 'Second result');
  assert.equal(second.verify.code, 0, 'the verdict stands; only landing waits');
  assert.match(second.verify.err, /LAND_ADOPT/u);
  assert.match(second.verify.err, /live process/u);
  const untouched = batchById(box, stuck.id);
  assert.equal(untouched.state, 'merging');
  assert.equal(untouched.revision, stuck.revision);
  assert.equal(untouched.owner, 'crashed-landing-session');
  assert.equal((await json(box, box.repo, 'show', String(first.id))).item_merged_commit, null);
});

test('liveness reads the recorded pid or a legacy pid owner, only on its own machine [B35,B3]', () => {
  const host = landingHost('fixture-host');
  const alive = () => {};
  const gone = () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); };
  const denied = () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); };
  assert.equal(landingProcessLive({ pid: 4242, host }, { host, probe: alive }), true);
  assert.equal(landingProcessLive({ pid: 4242, host }, { host, probe: gone }), false);
  assert.equal(landingProcessLive({ pid: 4242, host }, { host, probe: denied }), true, 'another user’s process is still live');
  assert.equal(landingProcessLive({ owner: 'pid-4242' }, { host, probe: alive }), true, 'a legacy batch names its pid in its owner');
  assert.equal(landingProcessLive({ owner: 'session-digest' }, { host, probe: alive }), false, 'an unrecorded process is judged by the held lease');
  assert.equal(landingProcessLive({ pid: 4242, host: landingHost('other-host') }, { host, probe: alive }), false, 'a foreign pid is never compared');
  assert.notEqual(landingHost('fixture-host'), 'fixture-host', 'the public board never sees the host name');
});

test('clause 1: the next accept adopts a merging batch whose process died, and both its waiting item and the new accept land [B35,B3,R3]', async t => {
  const { box, reviewer, first, trunk } = await waitingItem(t);
  const stuck = stuckBatch(box, { base: trunk, items: [{ id: first.id, commit: first.head }], pid: deadPid() });
  const second = await acceptItem(box, reviewer, 'second.txt', 'Second result');
  assert.equal(second.verify.code, 0, second.verify.out + second.verify.err);
  const resumed = batchById(box, stuck.id);
  assert.equal(resumed.state, 'landed', 'the interrupted batch itself resumes and lands');
  assert.notEqual(resumed.owner, 'crashed-landing-session');
  assert.notEqual(resumed.pid, stuck.pid, 'the adopting process records itself');
  for (const id of [first.id, second.id]) assert.ok((await json(box, box.repo, 'show', String(id))).item_merged_commit, `#${id} lands`);
  assert.equal(box.git(box.repo, 'show', 'main:web/first.txt'), 'First result');
  assert.equal(box.git(box.repo, 'show', 'main:web/second.txt'), 'Second result');
});
