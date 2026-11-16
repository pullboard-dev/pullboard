/** Keep next selection bounded with forty live claims by reading their background observations [H24]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import {
  recordClaimWorktrees,
  recordedClaimWorktrees,
} from '../../../../packages/activity/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { chargedText } from '../../tests/fixtures/load.js';
import { loadClock } from '../../tests/fixtures/load.js';

const BUDGET_MS = 200;
const CLI = new URL('../../tests/fixtures/native.js', import.meta.url).href;

const CLAIMS = 40;

/** Freeze fixture items without depending on the repository's live spec. */
function freeze(item) {
  return { text: JSON.stringify({ title: item.item_title, criterion: 'fixture work', check: 'true', rows: [] }), digest: 'fixture' };
}

test('next stays under 200 ms with forty claimed worktrees [H24]', (t) => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  const base = box.git(box.repo, 'rev-parse', 'HEAD').trim();
  const agents = store.listAgents(board);
  for (let index = 0; index < CLAIMS; index += 1) {
    const path = join(box.dir, `claimed-${index}`);
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', path, 'HEAD');
    const agentId = store.register(board, { lane: 'web', path, route: 'strong' });
    const itemId = store.addItem(board, { by: 'coordinator', lane: 'web', title: `Claim ${index}` });
    store.claim(board, itemId, { agentId, lane: 'web', leaseMs: 3_600_000, head: base, freeze });
  }
  const own = agents.find((agent) => agent.agent_path === box.web);
  assert.ok(own, 'the fixture seat is joined to the board');
  store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Available work' });

  recordClaimWorktrees(board, store.listItems(board), store.listAgents(board));
  const items = store.listItems(board);
  const workingFiles = recordedClaimWorktrees(items, store.listAgents(board), board, { own: box.web });
  assert.equal(workingFiles.size, CLAIMS, 'the forty claimed worktrees have recorded observations');
  store.nextFor(board, { agentId: own.agent_id, lane: 'web', workingFiles });
  const stop = loadClock();
  const selected = store.nextFor(board, { agentId: own.agent_id, lane: 'web', workingFiles });
  const elapsed = stop();
  assert.equal(selected.item?.item_title, 'Available work');
  // Charged for runner load per core like the file budgets (#6525): the number holds, measured as the case's own time.
  assert.ok(elapsed.ms < 200, `warm next selection took ${chargedText(elapsed)} with ${CLAIMS} claims`); // budget: approved row H24 sets this 200 ms speed ceiling.
});

/** Put a logging Git shim first on PATH so the test can detect scans in another seat's checkout. */
function gitLog(box) {
  const shims = join(box.dir, 'git-log-shim');
  mkdirSync(shims);
  const real = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8', env: box.env }).trim();
  const log = join(box.dir, 'git-launches.log');
  writeFileSync(join(shims, 'git'), `#!/bin/sh\nprintf '%s\\t%s\\n' "$(pwd -P)" "$*" >> "${log}"\nexec "${real}" "$@"\n`);
  chmodSync(join(shims, 'git'), 0o755);
  box.env.PATH = `${shims}:${box.env.PATH}`;
  return { reset: () => writeFileSync(log, ''), lines: () => readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

/** Warm native CLI commands in one process and return the median of three subsequent runs. */
function warmTimes(box, cwd, commands) {
  const source = `import { main } from ${JSON.stringify(CLI)};
const sink = { isTTY: false, write() { return true; } };
let profile = [];
const errSink = { isTTY: false, write(text) { if (String(text).startsWith('next profile:')) profile.push(String(text).trim()); return true; } };
const run = async argv => { profile = []; const started = performance.now(); const code = await main(argv, { cwd: ${JSON.stringify(cwd)}, stdout: sink, stderr: errSink, stdin: process.stdin }); return { code, ms: performance.now() - started, profile }; };
const result = {};
for (const argv of ${JSON.stringify(commands)}) {
  const first = await run(argv);
  if (first.code !== 0) { result[argv.join(' ')] = { code: first.code }; continue; }
  const times = [];
  let last;
  for (let round = 0; round < 3; round++) { last = await run(argv); times.push(last.ms); }
  result[argv.join(' ')] = { code: 0, median: times.sort((a, b) => a - b)[1], profile: last.profile.join(' | ') };
}
console.log(JSON.stringify(result));`;
  // Process-level case, kept: the 200 ms budget is wall-clock in one warm process, charged for the runner load over it (#6525).
  const stop = loadClock();
  const child = runFixtureChild(process.execPath, ['--input-type=module', '-e', source], { cwd, env: { ...box.env, PULLBOARD_NEXT_PROFILE: '1' }, encoding: 'utf8' });
  const { scale } = stop();
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const result = JSON.parse(child.stdout.trim().split('\n').at(-1));
  for (const entry of Object.values(result)) if (entry.code === 0) Object.assign(entry, { wall: entry.median, scale, median: entry.median / scale });
  return result;
}

test('next, inbox and show stay under 200 ms with forty recorded claims and scan no other seat [H24]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  const base = box.git(box.repo, 'rev-parse', 'HEAD').trim();
  const freeze = item => ({ text: JSON.stringify({ title: item.item_title, criterion: 'work', check: 'true', rows: [] }), digest: 'fixture' });
  const others = [];
  for (let index = 0; index < CLAIMS; index += 1) {
    const path = join(box.dir, `seat-${index}`);
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', path, 'HEAD');
    writeFileSync(join(path, `work-${index}.txt`), 'live edit\n');
    const agentId = store.register(board, { lane: 'web', path, route: 'strong' });
    const itemId = store.addItem(board, { by: 'coordinator', lane: 'web', title: `Seat ${index} work` });
    store.claim(board, itemId, { agentId, lane: 'web', leaseMs: 3_600_000, head: base, freeze });
    others.push(path);
  }
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'Next work', '--route', 'mid', '--specs', 'G1', '--criterion', 'Next work passes', '--check', 'true',
    '--brief', 'Files: web/next-work.js\nTest: the native fixture item has a named web path and a test description.', '--json');
  assert.equal(added.code, 0, added.err + added.out);
  const itemId = JSON.parse(added.out).item.item_id;
  const diagnosis = await box.runLocal(box.repo, 'fact', String(itemId), 'diagnosis',
    'Files: apps/cli/journeys/next/claims.test.js Change: add the open fixture item used by the timing check Test case: next, inbox and show stay under 200 ms with forty recorded claims and scan no other seat [H24]');
  assert.equal(diagnosis.code, 0, diagnosis.err + diagnosis.out);
  assert.equal(store.listItems(board).filter(item => item.item_status === 'claimed').length, CLAIMS);
  recordClaimWorktrees(board, store.listItems(board), store.listAgents(board));

  const launches = gitLog(box);
  launches.reset();
  const times = warmTimes(box, box.web, [['next'], ['inbox'], ['show', '1']]);
  for (const [command, result] of Object.entries(times)) assert.equal(result.code, 0, `${command} succeeds`);
  // Charged for runner load per core (#6525): each median is the command's own time, held to the H24 200 ms ceiling.
  const report = Object.entries(times).map(([command, result]) => `${command} ${chargedText({ ms: result.median, wall: result.wall, scale: result.scale })}`).join('; ');
  assert.ok(Object.values(times).every(result => result.median < BUDGET_MS), `medians with ${CLAIMS} claims: ${report}`); // budget: approved row H24 sets this 200 ms speed ceiling.
  t.diagnostic(`medians with ${CLAIMS} claims: ${report} (H24 ceiling ${BUDGET_MS} ms); next phases: ${times.next?.profile}`);
  const foreign = launches.lines().filter(line => others.some(path => line.startsWith(`${path}\t`)));
  assert.deepEqual(foreign, [], 'commands read other seats from the maintenance record without running Git there');
});
