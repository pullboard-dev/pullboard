/** Claim, release and next do their own job: no Git in any other seat's worktree, however many seats there are [B3,B4,N2]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { recordedClaimWorktrees } from '../../../../packages/activity/index.js';
import { sweepClaims } from '../../../../packages/health/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

const SEATS = 8;

/** Put a logging `git` ahead of the real one, so every Git launch by any process names its directory and arguments. */
function gitLog(box) {
  const shims = join(box.dir, 'git-log-shim');
  mkdirSync(shims);
  const real = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8', env: box.env }).trim();
  const log = join(box.dir, 'git-launches.log');
  writeFileSync(join(shims, 'git'), `#!/bin/sh\nprintf '%s\\t%s\\n' "$(pwd -P)" "$*" >> "${log}"\nexec "${real}" "$@"\n`);
  chmodSync(join(shims, 'git'), 0o755);
  box.env.PATH = `${shims}:${box.env.PATH}`;
  return {
    /** Forget earlier launches so the next read covers one command. */
    reset: () => writeFileSync(log, ''),
    /** Every launch since the last reset. */
    lines: () => readFileSync(log, 'utf8').split('\n').filter(Boolean),
  };
}

test('claim, release and next start no Git in other seats\' worktrees on a board with many seats [B3,B4,N2]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  // @pullboard-board-file journey: the CLI and these fixture seats share this private board.
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  const base = box.git(box.repo, 'rev-parse', 'HEAD').trim();
  const freeze = item => ({ text: JSON.stringify({ title: item.item_title, criterion: 'work', check: 'true', rows: [] }), digest: 'fixture' });
  const others = [];
  for (let n = 0; n < SEATS; n += 1) {
    const path = join(box.dir, `seat-${n}`);
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', path, 'HEAD');
    mkdirSync(join(path, 'web'), { recursive: true });
    writeFileSync(join(path, 'web', `work-${n}.js`), 'live edit\n');
    const agent = store.register(board, { lane: 'web', path, route: 'strong' });
    const id = store.addItem(board, { by: 'coordinator', lane: 'web', title: `Seat ${n} work` });
    store.claim(board, id, { agentId: agent, lane: 'web', leaseMs: 3_600_000, head: base, freeze });
    others.push(path);
  }
  for (const title of ['Own work', 'Next work']) {
    const added = fixtureAdd(box.run, box.repo, 'web', title, '--specs', 'G1', '--criterion', `${title} passes`, '--check', 'true');
    assert.equal(added.code, 0, added.err + added.out);
  }
  const own = store.listItems(board).find(item => item.item_title === 'Own work').item_id;
  const launches = gitLog(box);
  /** Run one command from the joined seat and return every Git launch aimed at another seat's worktree. */
  const foreign = (...args) => {
    launches.reset();
    const result = box.run(box.web, ...args);
    assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}${result.out}`);
    const lines = launches.lines();
    assert.ok(lines.some(line => line.startsWith(box.web)), `${args[0]} ran its own Git, so the log is live`);
    return lines.filter(line => others.some(path => line.includes(path)));
  };
  assert.deepEqual(foreign('claim', String(own)), [], 'claim and its renewal sweep read no other worktree');
  assert.deepEqual(foreign('claim', String(own)), [], 'a renewal reads no other worktree');
  assert.deepEqual(foreign('release', String(own), '--reason', 'OTHER', '--note', 'Fixture hands the item back.', '--no-next'), [],
    'release reads no other worktree');
  assert.deepEqual(foreign('next', '--build', '--json'), [], 'next routes from recorded files, not other worktrees');

  // Background maintenance is where other worktrees are read: it records each claim's files for the commands above.
  const ctx = { info: { root: box.repo }, config: {}, clock: { now: () => new Date() }, io: { err: () => {}, say: () => {} } };
  await sweepClaims(ctx, board, 'coordinator', async () => {});
  const recorded = recordedClaimWorktrees(store.listItems(board), store.listAgents(board), board);
  const seatItems = store.listItems(board).filter(item => item.item_title.startsWith('Seat '));
  assert.equal(seatItems.length, SEATS);
  for (const item of seatItems) {
    const n = Number(item.item_title.split(' ')[1]);
    assert.deepEqual(recorded.get(item.item_id), { files: [`web/work-${n}.js`], unknown: false }, `seat ${n}'s live edit is on record`);
  }
});
