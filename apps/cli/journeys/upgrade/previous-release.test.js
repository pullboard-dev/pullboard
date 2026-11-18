/** @pullboard-test-input apps/cli/tests/fixtures/upgrade-093/** */
/**
 * A board made by the previous release (0.9.3) upgrades in place and keeps working: current code opens it and replays
 * 0.9.3's recorded moves with the same results, a seat commits through the hooks 0.9.3 installed, and doctor ends clean
 * [R4,I1,A5] (#7788). Only the pre-push full gate runs this file; item gates leave it out through packages/gate/data/tests/push-only.json (#7788).
 */
import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { AGENT_SHELL_MARKERS } from '../../../../packages/kernel/index.js';
import { SSH_SHELL_MARKERS } from '../../../../packages/kernel/index.js';
import { codeIsFromMain } from '../../../../packages/git/index.js';
import { applyRelayMove } from '../../../../packages/state/index.js';
import { exportBoard } from '../../../../packages/store/index.js';
import { withoutPullboardEnv } from '../../tests/fixtures/e2e.js';
import { FIXTURE_MODEL } from '../../tests/fixtures/child.js';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';
import { runFixtureSetupGit } from '../../tests/fixtures/child.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { withFixtureBoard } from '../../tests/fixtures/board.js';

const FIXTURE = join(import.meta.dirname, '../../tests/fixtures/upgrade-093');
const BIN = join(import.meta.dirname, '../../pullboard.js');
/** The CLI's answer to a git hook's version probe (#7760), which the version shim below asks. */
const PROBE = pathToFileURL(join(import.meta.dirname, '../../src/io/hook/probe.js')).href;
/** The folder 0.9.3 built the fixture board in; its seats' recorded paths point here until a test moves them. */
const MADE_IN = '/private/tmp/pbfx/repo';
/** The version the CLI under test reports, which the 0.9.3 hooks are compared with. */
const OWN_VERSION = (await runCliInProcess(['--version'], { env: withoutPullboardEnv(process.env) })).stdout.trim();

/** The board tables a move can change, without the relay's own bookkeeping, which a replica does not share. */
function tables(board) {
  return Object.fromEntries(Object.entries(exportBoard(board).tables)
    .map(([name, rows]) => [name, name === 'board_meta' ? rows.filter(row => !/^relay_/u.test(row.meta_key)) : rows]));
}

/** A private folder for one test, removed after it. */
function scratch(t) {
  const { root: dir } = privateFixtureFiles('pullboard-upgrade-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('cli.journeys-upgrade-previous-release.current-code-opens-the-0-9: current code opens the 0.9.3 board and replays its recorded moves with identical results [R4,I1]', t => {
  const file = join(scratch(t), 'board.sqlite');
  copyFileSync(join(FIXTURE, 'board.sqlite'), file);
  const recorded = JSON.parse(readFileSync(join(FIXTURE, 'moves.json'), 'utf8'));
  assert.equal(recorded.release, '0.9.3');
  /** A result or table with the event ids (event_id, eventId) dropped: opening the board adds one guards event first, which shifts every later id by one. */
  const unnumbered = value => JSON.parse(JSON.stringify(value, (key, field) => key === 'event_id' || key === 'eventId' ? undefined : field));
  withFixtureBoard(file, board => {
    const opened = tables(board);
    assert.deepEqual(opened.item.map(row => [row.item_id, row.item_status]), [[1, 'verified'], [2, 'claimed'], [3, 'submitted'], [4, 'open']]);
    assert.equal(opened.item.find(row => row.item_id === 4).item_hold_by, 'coordinator', 'the hold survives the upgrade');
    assert.equal(opened.shout.length, 1, 'the shout survives the upgrade');
    assert.deepEqual(opened.agent.map(row => row.agent_id), ['coordinator', 'api-1', 'web-1', 'review-1']);
    const guards = opened.event.at(-1);
    assert.deepEqual([guards.event_kind, guards.event_by], ['guards', 'board'], 'opening installs this release\'s guards and records that once');
    assert.ok(JSON.parse(guards.event_detail).changed.includes('machine_item_move'));
    const refused = [];
    for (const { label, move, order, recorded: before, prepareRefused } of recorded.moves) {
      if (prepareRefused) { refused.push(label); continue; }
      let now;
      try { now = applyRelayMove(board, move, order); } catch (error) { now = { thrown: `${error.code} ${error.message}` }; }
      assert.deepEqual(unnumbered(now), unnumbered(before), `${label}: the result 0.9.3 recorded`);
      if (before?.error) refused.push(label);
    }
    assert.deepEqual(refused, ['claim in the wrong lane (refused)', 'withdraw again (refused)', 'reopen the landed item'], 'the refusals 0.9.3 gave are given again');
    const { sqlite_sequence: sequenceNow, ...now } = tables(board);
    const { sqlite_sequence: sequenceThen, ...then } = recorded.final;
    now.event = now.event.filter(row => row.event_id !== guards.event_id);
    assert.deepEqual(unnumbered(now), unnumbered(then), 'every table matches what 0.9.3 held after the same moves');
    const eventsThen = sequenceThen.find(row => row.name === 'event').seq, eventsNow = sequenceNow.find(row => row.name === 'event').seq;
    assert.equal(eventsNow, eventsThen + 1, 'the guards event is the only extra event');
  });
});

/**
 * The 0.9.3 project on disk: its committed files and hooks, its board, and the seat session files, in a private folder
 * with a web seat's worktree. The seats' recorded paths move to the folder the test made.
 */
function project(t) {
  const dir = scratch(t);
  const repo = join(dir, 'repo');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  // The release after 0.9.3 is 0.9.4; until the package version says so, this shim answers the version probe as 0.9.4
  // through the CLI's own hook probe, which tells hooks one release back their own version, as an installed 0.9.4 does (#7760).
  const probe = OWN_VERSION === '0.9.3' ? '0.9.4' : OWN_VERSION;
  const answer = `const { hookProbeVersion } = await import(process.argv[1]); process.stdout.write(hookProbeVersion(process.argv[2], { cwd: process.cwd(), env: process.env }) + '\\n');`;
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nif [ "$1" = --version ]; then exec "${process.execPath}" --input-type=module -e "${answer}" "${PROBE}" ${probe}; fi\nexec "${process.execPath}" "${BIN}" "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = {
    ...withoutPullboardEnv(process.env), PATH: `${bin}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture Author', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture Author', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    HOME: join(dir, 'home'), PULLBOARD_FIXTURE_BOARD: '1', PULLBOARD_HOME: join(dir, 'pullboard-home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'), PULLBOARD_CLAIM_BEATER: '0', PULLBOARD_USAGE_CHECKPOINT: 'inline',
    PULLBOARD_MODEL: FIXTURE_MODEL,
  };
  for (const marker of [...AGENT_SHELL_MARKERS, ...SSH_SHELL_MARKERS]) delete env[marker];
  const git = (cwd, ...args) => runFixtureChild('git', args, { cwd, env, encoding: 'utf8' });
  const setup = (cwd, ...args) => runFixtureSetupGit(args, { cwd, env });
  // The project 0.9.3 made: its own history, with the pins it keeps for submitted work, from a bundle of that repository.
  mkdirSync(repo);
  setup(repo, 'init', '-q', '-b', 'main');
  setup(repo, 'fetch', '-q', join(FIXTURE, 'repo.bundle'), '+refs/heads/main:refs/remotes/fixture/main', '+refs/pullboard/*:refs/pullboard/*');
  setup(repo, 'checkout', '-q', '-B', 'main', 'refs/remotes/fixture/main');
  setup(repo, 'config', 'core.hooksPath', '.githooks');
  setup(repo, 'config', 'pullboard.trunk', 'refs/heads/main');
  for (const hook of readdirSync(join(FIXTURE, 'hooks'))) {
    assert.equal(readFileSync(join(repo, '.githooks', hook), 'utf8'), readFileSync(join(FIXTURE, 'hooks', hook), 'utf8'), `${hook} is the script 0.9.3 installed`);
  }
  const worktree = join(repo, '.claude', 'worktrees', 'web-t');
  setup(repo, 'worktree', 'add', '-q', '--detach', worktree, 'main');
  mkdirSync(join(repo, '.git', 'pullboard'), { recursive: true });
  const board = join(repo, '.git', 'pullboard', 'board.sqlite');
  copyFileSync(join(FIXTURE, 'board.sqlite'), board);
  const db = new DatabaseSync(board);
  try { db.prepare('UPDATE agent SET agent_path = ? || substr(agent_path, ?) WHERE agent_path LIKE ?').run(repo, MADE_IN.length + 1, `${MADE_IN}%`); }
  finally { db.close(); }
  copyFileSync(join(FIXTURE, 'session-coordinator.json'), join(repo, '.git', 'pullboard-checkout-session.json'));
  copyFileSync(join(FIXTURE, 'session-web.json'), join(repo, '.git', 'worktrees', 'web-t', 'pullboard-checkout-session.json'));
  const seat = { ...env, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'fx-web' };
  const coordinator = { ...env, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'fx-coord' };
  const cli = (cwd, as, ...args) => runCliInProcess(args, { cwd, env: as });
  return { repo, worktree, git, seat, coordinator, cli };
}

/** One shell-free command line split on spaces: a refusal's `Run:` step is a plain command. */
const words = line => line.trim().split(/\s+/u);

test('cli.journeys-upgrade-previous-release.a-seat-commits-through-the-hooks: a seat commits through the hooks 0.9.3 installed, or is told one command that clears it from its worktree [R4,I1]', async t => {
  const box = project(t);
  writeFileSync(join(box.worktree, 'src/web/index.js'), "export const y = 1;\nexport function footer() { return '<p>bye</p>'; }\n");
  assert.equal(box.git(box.worktree, 'add', '-A').status, 0);
  let committed = box.git(box.worktree, 'commit', '-m', 'feat(web): footer [G1]');
  if (committed.status !== 0) {
    const step = /Run: (.+)$/mu.exec(committed.stderr + committed.stdout)?.[1];
    assert.ok(step, `a refused commit names the command that clears it: ${committed.stderr}${committed.stdout}`);
    const [command, ...args] = words(step);
    assert.equal(command, 'pullboard', 'the named step is a pullboard command');
    const cleared = await box.cli(box.worktree, box.seat, ...args);
    assert.equal(cleared.status, 0, `the named step works from the seat's worktree: ${cleared.stderr}${cleared.stdout}`);
    committed = box.git(box.worktree, 'commit', '-m', 'feat(web): footer [G1]');
  }
  assert.equal(committed.status, 0, committed.stderr + committed.stdout);
});

test('cli.journeys-upgrade-previous-release.doctor-on-the-upgraded-board-ends: doctor on the upgraded board ends clean after the steps it names [R4,A5]', async t => {
  const box = project(t);
  const repairs = problems => problems.map(problem => /^(?:run )?(pullboard [^;\n]+)/u.exec(problem.next ?? '')?.[1]).filter(Boolean);
  const found = await box.cli(box.repo, box.coordinator, 'doctor', '--json');
  for (const step of repairs(JSON.parse(found.stdout).problems)) {
    const [, ...args] = words(step);
    const done = await box.cli(box.repo, box.coordinator, ...args);
    assert.equal(done.status, 0, `${step}: ${done.stderr}${done.stdout}`);
  }
  const after = await box.cli(box.repo, box.coordinator, 'doctor', '--json');
  const remaining = JSON.parse(after.stdout).problems;
  // Only the main checkout's code repairs a board; a runner runs this source from a linked worktree, where doctor sends the person to main (#7761).
  if (codeIsFromMain()) {
    assert.equal(after.status, 0, after.stdout + after.stderr);
    assert.deepEqual(remaining, [], 'doctor reports no problems');
  } else {
    // A changed trigger's repair is a board write, inbox, since 443661e6e2 (#7924).
    assert.ok(remaining.some(problem => /^(?:run pullboard (?:status|inbox)|merge this code into the main checkout first)/u.test(problem.next)), 'doctor still names a repair');
  }
});
