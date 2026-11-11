/** Only main's tip is current tooling: a seat worktree's launch never makes a dispatcher hand over, so dispatchers never ping-pong (DJ16) [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../cli/tests/fixtures/child.js';
import { staleDispatcherTools } from '../../../src/io/handoff/dispatcher.js';
import { toolRootHead } from '../../../src/io/handoff/dispatcher.js';

/** A tool repository with trunk main at commit A, a seat worktree on an item branch at commit B, and a launch from each. */
function mainAndSeat(t) {
  const tool = privateFixtureFiles('pullboard-dispatch-trunk-');
  const main = join(tool.root, 'main');
  mkdirSync(main);
  const git = (cwd, ...args) => runFixtureGit(['-C', cwd, ...args]);
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'dispatch@example.test'], ['config', 'user.name', 'Dispatch Test'], ['config', 'pullboard.trunk', 'main']]) git(main, ...args);
  writeFileSync(join(main, 'tool.js'), 'export const VERSION = 1;\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'tooling A');
  const a = git(main, 'rev-parse', 'HEAD');
  const seat = join(tool.root, 'seat');
  git(main, 'worktree', 'add', '-q', '-b', 'item', seat);
  writeFileSync(join(seat, 'tool.js'), 'export const VERSION = 2;\n');
  git(seat, 'commit', '-q', '-am', 'item work B');
  const b = git(seat, 'rev-parse', 'HEAD');
  const snapshots = privateFixtureFiles('pullboard-dispatch-trunk-snapshots-');
  const launch = (job, toolRoot, commit) => {
    const tools = join(snapshots.root, `pullboard-handoff-tools-${commit}`);
    mkdirSync(tools, { recursive: true });
    const files = privateFixtureFiles('pullboard-dispatch-trunk-job-');
    files.write('request.json', JSON.stringify({ job, toolRoot, toolsCommit: commit }) + '\n');
    return { directory: files.root, job, tools };
  };
  // The seat's launch is the newest, as when a seat submits after the coordinator.
  const launches = [launch('job-main', main, a), launch('job-seat', seat, b)];
  t.after(() => { rmSync(tool.root, { recursive: true, force: true }); rmSync(snapshots.root, { recursive: true, force: true }); });
  return { a, seat, launches, mainTools: launches[0].tools, seatTools: launches[1].tools };
}

test('clause 1: a seat worktree\'s tooling commit is its trunk tip, never its item HEAD [C7]', t => {
  const { a, seat } = mainAndSeat(t);
  assert.equal(toolRootHead(seat), a, 'the seat worktree names main\'s tip as current tooling');
});

test('clause 1: a launch from a seat worktree never makes a dispatcher on main tooling hand over, and one on seat tooling hands back to main [C7]', t => {
  const { launches, mainTools, seatTools } = mainAndSeat(t);
  assert.equal(staleDispatcherTools({ own: mainTools, launches: () => launches }), null, 'the dispatcher on main tooling keeps launching');
  assert.equal(staleDispatcherTools({ own: seatTools, launches: () => launches }), mainTools, 'a dispatcher on a seat\'s tooling hands over to main tooling');
});
