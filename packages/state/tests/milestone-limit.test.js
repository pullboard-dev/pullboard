/** Optional release size is enforced by real CLI moves over Git and SQLite [N26,H16]. */
import assert from 'node:assert/strict';
import {
  execFileSync,
  spawnSync,
} from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import * as store from '../../../src/board.js';
import { openBoard } from '../../../src/native-board.js';
import {
  editMilestoneItems,
  editMilestone,
} from '../../../src/board-milestones.js';
import { submitFixture } from '../../../test/board-submit-fixture.js';
import { ENGINE_VERSION } from '../src/shell/machine.js';

const BIN = resolve(import.meta.dirname, '../../../bin/pullboard.js');
const HOUR = 3_600_000;
const TEMP_DIRS = [];

after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-milestones-'));
  TEMP_DIRS.push(dir);
  const repo = join(dir, 'repo');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  // The repo's hooks call pullboard by name, so the fixture puts this checkout's CLI on PATH.
  const word = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec ${word(process.execPath)} ${word(BIN)} "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  Object.assign(env, { HOME: join(dir, 'home'), PULLBOARD_HOME: join(dir, 'pullboard-home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Milestone fixture', GIT_AUTHOR_EMAIL: 'milestones@example.invalid',
    GIT_COMMITTER_NAME: 'Milestone fixture', GIT_COMMITTER_EMAIL: 'milestones@example.invalid', PATH: `${bin}:${process.env.PATH}` });
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env });
  /** Run Git inside the fixture repo with its private identity. */
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  /** Run as coordinator; fixture membership changes explicitly override automatic placement [B35]. */
  const run = (...args) => {
    if (args[0] === 'milestone' && !args.includes('--reason') && (args[1] === 'order' || args[1] === 'add' && args.includes('--items') || args[1] === 'items' && args.includes('--add'))) args.push('--reason', 'fixture release setup');
    const result = spawnSync(process.execPath, [BIN, ...args], { cwd: repo, env, encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  /** Run a command that must succeed and return its JSON document. */
  const json = (...args) => {
    const result = run(...args, '--json');
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  const initialized = run('init');
  assert.equal(initialized.status, 0, initialized.stdout + initialized.stderr);
  writeFileSync(join(repo, 'SPEC.md'), '# Fixture\n\n## G · Goals\n- G1 [approved, must] Work is tracked. | gate: true\n');
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true', verify: 'any', lanes: { web: { owns: ['web/'], specs: ['G1'] } }, shared: [] }));
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: initialize fixture');
  const board = openBoard(join(repo, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  store.ensureCoordinator(board, repo);
  const builder = store.register(board, { lane: 'web', path: join(dir, 'builder'), model: 'Fixture Model' });
  const freeze = () => ({ text: 'Tracked work', digest: 'digest:tracked' });
  /** File an item and take it to the named state: open, accepted or landed. */
  const item = (title, state) => {
    const id = store.addItem(board, { by: 'coordinator', lane: 'web', title, criterion: 'Tracked work', specIds: ['G1'] });
    if (state === 'open') return id;
    const commit = String(id).repeat(40).slice(0, 40);
    store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: HOUR, freeze });
    submitFixture(board, id, { agentId: builder, commit, tree: 'tree' });
    store.verify(board, id, { agentId: 'coordinator', decision: 'ACCEPT', note: 'checked it', head: commit, digest: 'digest:tracked', policy: 'any' });
    if (state === 'landed') store.merged(board, id, { agentId: 'coordinator', commit: git('rev-parse', 'HEAD') });
    return id;
  };
  return { repo, git, run, json, board, builder, item };
}


test('a milestone with a limit refuses an add past it and accepts a swap [N26,H16]', (t) => {
  const box = fixture(t);
  const first = box.item('Unstarted release work', 'open');
  const building = box.item('Already building', 'open');
  const incoming = box.item('New release work', 'open');
  store.claim(box.board, building, { agentId: box.builder, lane: 'web', leaseMs: HOUR,
    freeze: () => ({ text: 'Tracked work', digest: 'digest:tracked' }) });
  const plan = () => box.json('roadmap').milestones.find(entry => entry.name === 'release');
  box.json('milestone', 'add', 'release', '--items', `${first},${building}`);
  assert.equal(plan().limit, null, 'limits are off by default');
  box.json('milestone', 'edit', 'release', '--limit', '2');
  assert.equal(plan().limit, 2);
  assert.equal(plan().count, 2);
  const refused = box.run('milestone', 'items', 'release', '--add', String(incoming));
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /MILESTONE_LIMIT/);
  assert.match(refused.stderr, /3 items.*limit 2/);
  assert.match(refused.stderr, new RegExp(`unstarted.*#${first}`));
  assert.doesNotMatch(refused.stderr, new RegExp(`#${building}(?:\\D|$)`), 'started work is not offered as a swap candidate');
  assert.deepEqual(store.milestones(box.board)[0].items, [first, building], 'refusal leaves the milestone unchanged');
  box.json('milestone', 'items', 'release', '--add', String(incoming), '--swap', String(first));
  assert.deepEqual(store.milestones(box.board)[0].items, [incoming, building]);
  assert.equal(plan().count, 2);
  assert.match(box.run('roadmap').stdout, /release: .*2\/2 items/);
  const invalid = box.run('milestone', 'items', 'release', '--add', String(first), '--swap', '999999');
  assert.notEqual(invalid.status, 0);
  assert.deepEqual(store.milestones(box.board)[0].items, [incoming, building], 'an invalid swap makes neither half of its change');
  box.json('milestone', 'edit', 'release', '--limit', 'none');
  box.json('milestone', 'items', 'release', '--add', String(first));
  assert.equal(plan().limit, null);
  assert.equal(plan().count, 3);
});


test('[N26,H16] caps validate edits, shipment carry and historical replay without partial changes', (t) => {
  const box = fixture(t);
  const first = box.item('First', 'open');
  const second = box.item('Second', 'open');
  box.json('milestone', 'add', 'source', '--items', String(first));
  box.json('milestone', 'add', 'target');
  box.json('milestone', 'edit', 'target', '--limit', '0');
  for (const limit of ['-1', '1.5', 'abc', '9007199254740992']) {
    assert.notEqual(box.run('milestone', 'edit', 'target', '--limit', limit).status, 0, limit);
    assert.equal(store.milestones(box.board)[1].limit, 0);
  }
  const before = store.milestones(box.board);
  assert.notEqual(box.run('milestone', 'ship', 'source', '--next', 'target').status, 0);
  assert.deepEqual(store.milestones(box.board), before, 'a capped carry does not ship or move anything');
  box.json('milestone', 'edit', 'target', '--limit', '1');
  box.json('milestone', 'ship', 'source', '--next', 'target');
  assert.deepEqual(store.milestones(box.board)[1].items, [first]);
  assert.notEqual(box.run('milestone', 'edit', 'target', '--name', 'renamed', '--limit', '0').status, 0);
  assert.equal(store.milestones(box.board)[1].name, 'target', 'invalid cap also rolls back the rename');
  const currentEngine = box.board.executionEngineVersion;
  try {
    box.board.executionEngineVersion = 1;
    editMilestoneItems(box.board, 'target', { agentId: 'coordinator', add: [second] });
    assert.deepEqual(store.milestones(box.board)[1].items, [first, second], 'historical uncapped moves replay unchanged');
    assert.throws(() => editMilestone(box.board, 'target', { agentId: 'coordinator', limit: 3 }), { code: 'ENGINE_VERSION' });
    assert.throws(() => editMilestoneItems(box.board, 'target', { agentId: 'coordinator', add: ['other#1'], swap: [first] }), { code: 'ENGINE_VERSION' });
  } finally { box.board.executionEngineVersion = currentEngine; }
});
