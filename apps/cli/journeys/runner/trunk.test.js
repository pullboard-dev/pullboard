/** One trunk remote setting: runner serve, the pull lander's land job and landingRemote all read trunk.remote, with landing.trunkRemote as its old name for one release [P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { apiHttpBox } from '../../tests/fixtures/api.js';
import { fixtureMachineSettings } from '../../tests/fixtures/testkit.js';
import { configFromSource } from '../../../../packages/config/index.js';
import { configTrunkRemote } from '../../../../packages/config/index.js';
import { loadConfig } from '../../../../packages/config/index.js';
import { describeSetting } from '../../../../packages/config/index.js';
import { trunkRemote } from '../../../../packages/config/index.js';
import { offerJob } from '../../../../packages/api/index.js';
import { offerLandingJob } from '../../../../packages/api/index.js';
import { serveRunner } from '../../../../packages/drive/index.js';
import { landingRemote } from '../../../../packages/landing/index.js';
import { runLandingJob } from '../../../../packages/landing/index.js';

/**
 * A local board serving its job queue under pull, a bare trunk remote apart from the board host's repository, and one
 * item commit on that remote. `setting` is written into the board's pullboard.json as given.
 */
async function trunkBoard(t, setting) {
  const box = await apiHttpBox(t);
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gate: { runnerDispatch: 'pull' } });
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', ...args], { cwd, env: box.env, encoding: 'utf8' }).trim();
  const trunk = join(box.dir, 'trunk.git');
  const source = join(box.dir, 'source');
  git(box.dir, 'clone', '-q', '--bare', box.root, trunk);
  git(box.dir, 'clone', '-q', trunk, source);
  writeFileSync(join(source, 'item.txt'), 'item 1\n');
  git(source, 'add', 'item.txt');
  git(source, 'commit', '-q', '-m', 'feat(core): item 1 [P7]');
  git(source, 'push', '-q', trunk, 'HEAD:refs/heads/item/1');
  const commit = git(source, 'rev-parse', 'HEAD');
  const file = join(box.root, 'pullboard.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...setting(trunk) }, null, 2));
  const db = new DatabaseSync(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => db.close());
  const tip = () => git(box.dir, '--git-dir', trunk, 'rev-parse', 'refs/heads/main');
  return { box, trunk, commit, db, tip, board: `${box.origin}${box.path}?k=${box.key}`, cache: join(box.dir, 'runner-cache') };
}

/** Each reader's remote: config, landingRemote, a runner's claim, and a landing job's payload; then run that job. */
async function readers(t, setting) {
  const fixture = await trunkBoard(t, setting);
  const { box, commit, db, board, cache, tip } = fixture;
  offerJob(db, { id: 'gate:one-remote', kind: 'gate', needs: [], candidate: commit, run: [process.execPath, '-e', '0'] });
  const answers = [];
  const fetchImpl = async (url, init) => { const response = await fetch(url, init); answers.push(await response.clone().json()); return response; };
  const served = await serveRunner({ board, runner: 'r-one', capabilities: [], cache, once: true, fetchImpl });
  assert.deepEqual(served.jobs.map(job => job.outcome), ['posted'], 'runner serve fetched the candidate from the trunk remote');
  const before = tip();
  const offered = offerLandingJob(db, { items: [{ id: 1, commit, ref: 'refs/heads/item/1' }], expect: before, config: loadConfig(box.root), mode: 'pull' });
  const { payload } = offered.steps.find(step => step.name === 'offered').payload;
  const receipt = await runLandingJob(payload, { workdir: join(box.dir, 'land') });
  return { ...fixture, before, receipt, remotes: {
    config: trunkRemote(box.root), lander: landingRemote(box.root, 'refs/heads/main'),
    claim: answers.find(answer => answer.claim)?.trunk, job: payload.remote } };
}

test('clause 1: trunk.remote is the one remote runner serve, the land job and landingRemote read [P7]', { timeout: 120_000 }, // budget: hang ceiling for a private init, API start, git fetches and a landing.
async t => {
  const { trunk, remotes, receipt, tip, before, commit } = await readers(t, remote => ({ trunk: { remote } }));
  assert.deepEqual(remotes, { config: trunk, lander: trunk, claim: trunk, job: trunk });
  assert.equal(receipt.outcome, 'landed', receipt.detail ?? '');
  assert.notEqual(tip(), before, 'the land job pushed trunk to trunk.remote');
  execFileSync('git', ['--git-dir', trunk, 'merge-base', '--is-ancestor', commit, 'refs/heads/main']); // throws unless the item is on trunk
});

test('clause 1: landing.trunkRemote alone is read as trunk.remote for one release, by every reader [P7]', { timeout: 120_000 }, // budget: as above.
async t => {
  const { trunk, remotes, receipt } = await readers(t, remote => ({ landing: { trunkRemote: remote } }));
  assert.deepEqual(remotes, { config: trunk, lander: trunk, claim: trunk, job: trunk });
  assert.equal(receipt.outcome, 'landed', receipt.detail ?? '');
});

test('clause 1: one setting; the old name is described as deprecated and may not name a second remote [P7]', () => {
  assert.equal(configTrunkRemote({ trunk: { remote: 'https://example.invalid/a.git' }, landing: { trunkRemote: 'https://example.invalid/a.git' } }), 'https://example.invalid/a.git');
  assert.equal(configTrunkRemote({ trunk: { remote: '' }, landing: { trunkRemote: '/srv/trunk.git' } }), '/srv/trunk.git');
  assert.equal(configTrunkRemote({ trunk: { remote: '' } }), null);
  assert.equal(configFromSource(JSON.stringify({ trunk: { remote: '/srv/t.git' }, landing: { trunkRemote: '/srv/t.git' } })).trunk.remote, '/srv/t.git', 'the same remote under both names is accepted');
  assert.throws(() => configFromSource(JSON.stringify({ trunk: { remote: '/srv/a.git' }, landing: { trunkRemote: '/srv/b.git' } })), /old name for "trunk.remote" and names a different remote/u);
  assert.throws(() => configFromSource(JSON.stringify({ landing: { trunkRemote: 'https://me:secret@example.invalid/r.git' } })), /must not carry a password/u);
  assert.match(describeSetting('landing.trunkRemote').description, /^Deprecated: the old name for trunk\.remote/u);
});
