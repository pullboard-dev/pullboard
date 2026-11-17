/** @pullboard-test-input source-cell link */
/** With relay.excludeByBoard on, a relay exclusion is keyed by the board, and old checkout-keyed entries still count [C7,#9414]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { clearRelayExclusion } from '../../../src/io/relay/exclusion.js';
import { excludeRelayByPerson } from '../../../src/io/relay/exclusion.js';
import { relayExclusion } from '../../../src/io/relay/exclusion.js';
import { readRelayMachine } from '../../../src/io/relay/machine.js';
import { updateRelayMachine } from '../../../src/io/relay/machine.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';
import { openCellBoard } from '../../../../store/tests/fixtures/cell.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';

const IO = { personChannel: 'view' };
/** The person-intent record lands on a real in-memory board, as the relay's own recorder writes it. */
const records = () => (root, work) => work(openCellBoard(':memory:', { now: () => new Date('2026-11-16T12:00:00.000Z') }));

/** Two worktrees of one board and a second board, under a private machine home with the setting on or off. */
function boards(t, excludeByBoard) {
  const files = privateFixtureFiles('pullboard-exclusion-board-key-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  const home = join(files.root, 'machine-home');
  mkdirSync(home, { recursive: true });
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
  fixtureMachineSettings(home, excludeByBoard ? { relay: { excludeByBoard: true } } : {});
  const step = (cwd, ...args) => runFixtureGit(args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  const repo = join(files.root, 'repo');
  const other = join(files.root, 'other');
  for (const dir of [repo, other]) {
    mkdirSync(dir);
    step(dir, 'init', '-q', '-b', 'main');
    step(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
  }
  const second = join(files.root, 'second');
  step(repo, 'worktree', 'add', '-q', second, '-b', 'second');
  return { repo, second, other };
}

test('link.exclusion-board-key.on-covers-every-worktree: clause 1: with relay.excludeByBoard on, excluding from one worktree excludes every worktree of that board and no other board [C7,#9414]', t => {
  const { repo, second, other } = boards(t, true);
  assert.equal(excludeRelayByPerson(repo, IO, { localRecords: records() }), true);
  assert.ok(relayExclusion(repo), 'the worktree it was made in');
  assert.ok(relayExclusion(second), 'a second worktree of the same board');
  assert.equal(relayExclusion(other), null, 'a different board');
  assert.equal(clearRelayExclusion(second), true, 'clearing from another worktree clears the board');
  assert.equal(relayExclusion(repo), null);
});

test('link.exclusion-board-key.old-keys-read-as-board: clause 2: an old checkout-keyed exclusion reads as the board\'s, and with the setting off the keying is unchanged [C7,#9414]', t => {
  const on = boards(t, true);
  excludeRelayByPerson(on.repo, { personChannel: 'view' }, { localRecords: records() });
  updateRelayMachine(state => {
    state.excluded = [on.repo];
    state.exclusionDetails = { [on.repo]: { reason: 'person relay off', path: 'relayOff', by: 'person', at: 'then', eventId: 7 } };
  });
  assert.equal(relayExclusion(on.second)?.eventId, 7, 'an entry keyed by one checkout root covers its other worktree');
  assert.equal(relayExclusion(on.other), null);
  const off = boards(t, false);
  // The machine record can outlive the first fixture home inside one process, so the off half starts from an empty one.
  updateRelayMachine(state => { state.excluded = []; state.exclusionDetails = {}; });
  excludeRelayByPerson(off.repo, IO, { localRecords: records() });
  assert.ok(relayExclusion(off.repo));
  assert.equal(relayExclusion(off.second), null, 'off: a second worktree is not excluded');
  assert.deepEqual(readRelayMachine().excluded, [off.repo], 'off: the key is the checkout root');
});
