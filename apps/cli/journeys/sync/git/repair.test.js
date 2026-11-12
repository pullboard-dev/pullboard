/** Private CLI journeys preserve one transport while recovering foreign local state [H11,C7]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import { readGitSyncRepairs } from '../../../../../packages/config/index.js';
import { readGitSyncMarker } from '../../../../../packages/config/index.js';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { runFixtureGit } from '../../../tests/fixtures/child.js';
import { relayClientFixture } from '../../../tests/fixtures/relay/client.js';
import * as store from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { syncGitBoard } from '../../../../../packages/sync/index.js';

/** Demand a successful fixture CLI result without including its synthetic relay credentials. */
function success(result, label) {
  assert.equal(result.code, 0, `${label}: ${result.document?.error?.code ?? result.code}; ${result.failure ?? ''}`);
  return result.document;
}

/** Return the board's shared Git metadata path for this repository and its worktrees. */
function commonPullboard(box) {
  const common = runFixtureGit(['rev-parse', '--git-common-dir'], { cwd: box.root, env: box.env, encoding: 'utf8' });
  return join(resolve(box.root, common), 'pullboard');
}

test('submit on a relay-linked board never creates Git sync state and later writes still work [H11,C7]', async t => {
  // The fixture runs its provider on loopback and generates all credentials locally; no live relay is contacted.
  const box = await relayClientFixture(t);
  symlinkSync(resolve(import.meta.dirname, '../../../pullboard.js'), join(box.env.PATH, 'pullboard'));
  const buildLane = 'fixture-build';
  const config = JSON.parse(readFileSync(join(box.root, 'pullboard.json'), 'utf8'));
  config.gate = 'test -f source/repair-fixture.txt';
  config.lanes[buildLane] = { owns: ['source/'], specs: ['G'], starts: 'now' };
  writeFileSync(join(box.root, 'pullboard.json'), JSON.stringify(config, null, 2) + '\n');
  writeFileSync(join(box.root, 'SPEC.md'), '# Private fixture\n\n## G · Goals\n\n- G1 [approved, must] The committed fixture source is present. | gate: test -f source/repair-fixture.txt\n');
  runFixtureGit(['add', '-A'], { cwd: box.root, env: box.env, encoding: 'utf8' });
  runFixtureGit(['commit', '-q', '-m', 'test: prepare linked submission [G1]'], { cwd: box.root, env: box.env, encoding: 'utf8' });
  await box.link();
  success(await box.cli('shout', 'all', 'establish relay history for sync self-repair'), 'record linked relay history');
  const metadata = commonPullboard(box);
  assert.equal(existsSync(join(metadata, 'git-sync.json')), false, 'relay history is not Git-sync opt-in');

  const added = success(await box.cli('add', buildLane, 'linked submit fixture', '--specs', 'G1',
    '--criterion', 'The committed fixture source is present.', '--check', 'test -f source/repair-fixture.txt'), 'add the linked submit fixture item');
  const worker = join(dirname(box.root), 'submit-worker');
  runFixtureGit(['worktree', 'add', '-q', '-b', 'web/git-sync-repair', worker], {
    cwd: box.root, env: box.env, encoding: 'utf8',
  });
  success(await box.cliAt(worker, 'join', buildLane, '--model', 'fixture-model', '--route', 'strong'), 'join a private builder');
  success(await box.cliAt(worker, 'claim', String(added.item.item_id)), 'claim the linked item');
  mkdirSync(join(worker, 'source'), { recursive: true });
  writeFileSync(join(worker, 'source', 'repair-fixture.txt'), 'source for the linked submit\n');
  runFixtureGit(['add', '-A'], { cwd: worker, env: box.env, encoding: 'utf8' });
  runFixtureGit(['commit', '-q', '-m', 'feat(web): linked submit fixture [G1]'], {
    cwd: worker, env: box.env, encoding: 'utf8',
  });

  success(await box.cliAt(worker, 'submit', String(added.item.item_id)), 'submit on relay-linked history');
  assert.equal(existsSync(join(metadata, 'git-sync.json')), false, 'submit must not create the Git-sync marker');
  success(await box.cli('add', buildLane, 'write after linked submit', '--specs', 'G1',
    '--criterion', 'Another ordinary board write remains available after submission.'), 'write after the linked submit');
  assert.equal(existsSync(join(metadata, 'git-sync.json')), false, 'later relay writes do not create the marker');
});

test('a foreign marker and dead legacy lock are quarantined on the next write and appear in health [H11,C7]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  success(await box.cli('shout', 'all', 'establish relay history before planting stale sync state'), 'record linked relay history');
  const metadata = commonPullboard(box);
  mkdirSync(metadata, { recursive: true });
  const marker = join(metadata, 'git-sync.json');
  const lock = join(metadata, 'git-sync.json.lock');
  const pid = 99999999;
  const command = 'submit';
  const at = '2026-10-29T22:27:00.000Z';
  writeFileSync(marker, JSON.stringify({ version: 1, remote: 'origin', ref: 'refs/pullboard/board',
    writer: { command: 'submit', pid, at } }) + '\n');
  mkdirSync(lock, { mode: 0o700 });
  writeFileSync(join(lock, 'pid'), String(pid));
  const originalMarker = readFileSync(marker), originalPid = readFileSync(join(lock, 'pid'));

  success(await box.cli('add', box.lane, 'write after stale sync state'), 'repair before the next board write');
  assert.equal(existsSync(marker), false, 'the foreign marker leaves its active location');
  assert.equal(existsSync(lock), false, 'the dead-PID legacy lock leaves its active location');
  const repairs = readGitSyncRepairs(box.root);
  assert.ok(repairs.every(repair => repair.version === 1));
  const artifacts = repairs.flatMap(repair => repair.artifacts);
  assert.deepEqual(new Set(artifacts.map(artifact => artifact.name)), new Set(['git-sync.json', 'git-sync.json.lock']));
  assert.ok(artifacts.some(artifact => artifact.pid === pid && artifact.command === command && artifact.at === at),
    'the repair preserves the marker writer pid, command and time');
  assert.ok(artifacts.some(artifact => artifact.name === 'git-sync.json.lock' && artifact.pid === pid),
    'the repair records the dead legacy lock owner');
  assert.deepEqual(readFileSync(artifacts.find(artifact => artifact.name === 'git-sync.json').path), originalMarker);
  assert.deepEqual(readFileSync(join(artifacts.find(artifact => artifact.name === 'git-sync.json.lock').path, 'pid')), originalPid);

  const healthResult = await box.cli('health');
  const health = healthResult.document;
  assert.ok(Array.isArray(health.stuck), 'health returns its normal report, not an operation refusal');
  assert.equal(healthResult.code, health.stuck.length ? 1 : 0, 'health preserves its existing stuck-work exit status');
  assert.deepEqual(health.gitSyncRepairs, repairs, 'health reports the same durable repair summary');
  const text = box.startCli(['health'], {}, { json: false });
  const textResult = await text.closed;
  assert.equal(textResult.code, healthResult.code, 'text health preserves the structured report exit status');
  assert.match(text.stdout, new RegExp(String(pid), 'u'));
  assert.ok(text.stdout.includes(command), 'health text names the observed command');
  assert.ok(text.stdout.includes(at), 'health text names the observed timestamp');
  assert.match(text.stdout, /git-sync\.json/u);
  assert.match(text.stdout, /git-sync\.json\.lock/u);
});

test('an internal retry refuses relay history before creating a marker or starting Git transport [H11,C7]', async t => {
  const box = await relayClientFixture(t);
  await box.link();
  success(await box.cli('shout', 'all', 'establish relay history before internal retry'), 'record relay history');
  // Removing only the private fixture remote makes any accidental transport attempt fail locally.
  runFixtureGit(['remote', 'remove', 'origin'], { cwd: box.root, env: box.env, encoding: 'utf8' });
  const metadata = commonPullboard(box);
  // @pullboard-board-file journey: open the same isolated native board to call the internal transport adapter.
  const board = openBoard(join(metadata, 'board.sqlite'));
  try {
    await assert.rejects(syncGitBoard(box.root, board, { relayCommand: { cliOperation: 'submit' } }), { code: 'GIT_SYNC_LINKED' });
    assert.equal(existsSync(join(metadata, 'git-sync.json')), false);
    assert.equal(existsSync(join(metadata, 'git-sync.json.lock')), false, 'history refusal precedes lock acquisition');
  } finally { store.closeBoard(board); }
});

test('a board folder replaced by a file refuses the marker read with its next step [H11,C7]', t => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-git-sync-enotdir-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, encoding: 'utf8' });
  writeFileSync(join(root, '.git', 'pullboard'), 'not a folder\n');
  assert.throws(() => readGitSyncMarker(root), error => error.name === 'Refused' && error.code === 'GIT_SYNC_FOLDER'
    && /is not a directory/u.test(error.message) && /move .*pullboard aside, then run pullboard doctor/u.test(error.next ?? error.message));
});
