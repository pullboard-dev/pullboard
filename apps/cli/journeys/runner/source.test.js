/** Warm runner source reuses only clean private base trees and transports actual deltas [C7]. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  after,
  test,
} from 'node:test';
import { checkSourceTagNames } from '../../../../packages/runners/index.js';
import { takeResource } from '../../../../packages/resources/index.js';
import {
  cleanupFixtureChildren,
  runFixtureChild,
} from '../../tests/fixtures/child.js';
import { pathToFileURL } from 'node:url';
import {
  HOST,
  installSshStandIn,
  shellQuote,
} from '../../tests/fixtures/runner/ssh.js';
import {
  cleanupToolingSnapshots,
  fixtureResultContext,
  gateResult,
  git,
  runThroughGate,
} from '../../tests/fixtures/runner/tooling.js';

after(cleanupFixtureChildren);
after(cleanupToolingSnapshots);

test('warm runner source moves a clean base and sends only the changed history [C7]', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-warm-source-')));
  let completed = false;
  t.after(() => { if (completed) rmSync(dir, { recursive: true, force: true }); else t.diagnostic(`retained source fixture ${dir}`); });
  const home = join(dir, 'home'), machineHome = join(home, '.pullboard');
  const remoteHome = join(dir, 'remote-home'), remoteMachine = join(remoteHome, '.pullboard');
  const repo = join(dir, 'repo'), worker = join(dir, 'worker'), bin = join(dir, 'bin');
  const requests = join(dir, 'requests.jsonl'), stderrLog = join(dir, 'worker.stderr');
  for (const folder of [home, machineHome, remoteHome, remoteMachine, repo, worker, bin]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(machineHome, 'settings.json'), JSON.stringify({ gateSlots: 1 }));
  const env = { ...process.env, HOME: home, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machineHome,
    PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Warm source fixture', GIT_AUTHOR_EMAIL: 'warm@example.invalid',
    GIT_COMMITTER_NAME: 'Warm source fixture', GIT_COMMITTER_EMAIL: 'warm@example.invalid' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_CONFIG_PARAMETERS']) delete env[key];
  git(repo, env, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true' }));
  writeFileSync(join(repo, 'tracked.txt'), 'base source\n');
  // Real incompressible tracked bytes make a missing full-history transfer observable.
  writeFileSync(join(repo, 'unchanged.bin'), Buffer.concat([Buffer.from([0]), randomBytes(128 * 1024)]));
  // Past Git's 100-object unpack limit, a resent base history lands as a second pack in the job checkout.
  mkdirSync(join(repo, 'many'));
  for (let index = 0; index < 120; index++) writeFileSync(join(repo, 'many', `file-${index}.txt`), `unchanged ${index}\n`);
  git(repo, env, 'add', '.'); git(repo, env, 'commit', '-qm', 'test: warm source base');
  const base = git(repo, env, 'rev-parse', 'HEAD');
  const sourceTags = Array.from({ length: 40 }, (_, index) => `source-${String(index).padStart(2, '0')}`);
  for (const tag of sourceTags) git(repo, env, 'tag', tag);
  installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachine, requests, stderrLog });
  // Register the runner through the runners cell's registration probe (the steps `runner add` performs), in a child on this fixture's machine home.
  const cellUrl = cell => JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../..', 'packages', cell, 'index.js')).href);
  const registration = `import { addRunner, validateRunner } from ${cellUrl('config')};
import { probeRunnerTransport } from ${cellUrl('runners')};
import { recordRunnerGui } from ${cellUrl('resources')};
const probed = validateRunner({ host: ${JSON.stringify(HOST)}, slots: 1, browser: 0 });
const observation = await probeRunnerTransport(probed, { observeGui: true, discoverNode: true, enrollSigningKey: true });
if (!observation.healthy || typeof observation.publicKey !== 'string' || !observation.nodePath) throw new Error('registration probe failed: ' + JSON.stringify(observation));
probed.node = observation.nodePath;
const measured = observation.cores !== undefined ? { cores: observation.cores, memoryMB: observation.memoryMB, measuredAt: new Date().toISOString() } : {};
const runner = addRunner({ ...validateRunner({ ...probed, slots: 1, browser: 0, fixed: true, ...measured, publicKey: observation.publicKey }), gui: observation.gui });
recordRunnerGui(runner.host, observation.gui);
`;
  const added = runFixtureChild(process.execPath, ['--input-type=module', '-e', registration], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(added.status, 0, added.context);
  const previous = [process.env.PULLBOARD_HOME, process.env.PULLBOARD_MACHINE_HOME];
  process.env.PULLBOARD_HOME = home; process.env.PULLBOARD_MACHINE_HOME = machineHome;
  let held;
  /** Decode the real nonce-bound worker receipts copied by the stand-in. */
  const receipts = () => readFileSync(stderrLog, 'utf8').split(/\r?\n/u).filter(line => line.startsWith('PULLBOARD_RUNNER_RESULT '))
    .map(line => JSON.parse(Buffer.from(line.split(' ')[2], 'base64').toString('utf8')));
  /** Run actual source assertions and return this run's source measurement. */
  const run = async (expected, mutate = false, forbidden = null, expectedTags = sourceTags, packs = null) => {
    const body = `const a=require('node:assert/strict'),f=require('node:fs'),c=require('node:child_process');
      a.equal(f.readFileSync('tracked.txt','utf8'),${JSON.stringify(expected)});
      a.equal(f.existsSync('command-poison'),false);
      a.equal(c.execFileSync('git',['tag','--list','command-poison'],{encoding:'utf8'}),'');
      a.deepEqual(c.execFileSync('git',['tag','--list'],{encoding:'utf8'}).trim().split(/\\n/).filter(Boolean),${JSON.stringify(expectedTags)});
      a.equal(c.execFileSync('git',['status','--porcelain'],{encoding:'utf8'}),'');
      a.equal(c.execFileSync('git',['rev-parse','--is-shallow-repository'],{encoding:'utf8'}).trim(),'false');
      a.equal(c.execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim(),${JSON.stringify(git(repo, env, 'rev-parse', 'HEAD^{tree}'))});
      a.equal(f.existsSync('.git/objects/info/alternates'),false);
      ${packs === null ? '' : `a.equal(f.readdirSync('.git/objects/pack').filter(n=>n.endsWith('.pack')).length,${packs},'job checkout holds the base pack and only the new objects');`}
      ${forbidden ? `a.notEqual(c.spawnSync('git',['cat-file','-e',${JSON.stringify(forbidden)}],{encoding:'utf8'}).status,0);` : ''}
      ${mutate ? "f.writeFileSync('tracked.txt','command mutation');f.writeFileSync('command-poison','private job mutation');c.execFileSync('git',['tag','command-poison']);" : ''}
      process.stdout.write('SOURCE_ASSERTIONS_PASSED\\n');`;
    // budget: dispatch waits on this host's own admission queue, which a loaded reviewer machine can hold past the default
    // 20 s; this file proves the worker-measured source phase, so dispatch gets 60 s and the remaining deadlines stay.
    const result = await runThroughGate(repo, env, `node -e ${shellQuote(body)}`, { browser: false, requests, deadlines: { dispatch: 60_000 } });
    assert.equal(result.status, 0, fixtureResultContext(result));
    assert.equal(gateResult(result.stdout).runner, HOST);
    assert.match(result.stdout, /SOURCE_ASSERTIONS_PASSED/u);
    return receipts().at(-1);
  };
  try {
    held = await takeResource({ name: 'gate', capacity: 1, scope: 'machine', root: repo, agent: 'warm-source-local-holder' });
    const cold = await run('base source\n', true);
    const warm = await run('base source\n');
    assert.equal(warm.sourcePreparation.reusedCommit, base, 'second job reused the private clean base tree');
    assert.equal(warm.sourcePreparation.git.fetch.calls, 1, 'all forty short tags are delivered by one actual worker fetch');
    assert.equal(warm.sourcePreparation.packBytes, 32, 'same-base transport contains the real empty SHA-1 pack');
    assert.ok(cold.sourcePreparation.packBytes > 64 * 1024, 'cold transport contained the real bulk history');
    writeFileSync(join(repo, 'tracked.txt'), 'changed source\n');
    git(repo, env, 'add', 'tracked.txt'); git(repo, env, 'commit', '-qm', 'test: changed source delta');
    const changed = await run('changed source\n', false, null, sourceTags, 1);
    assert.equal(changed.sourcePreparation.reusedCommit, base, 'descendant source reuses the prior base before checkout');
    assert.ok(changed.sourcePreparation.packBytes > 32, 'new source sends actual new objects');
    assert.ok(changed.sourcePreparation.packBytes < cold.sourcePreparation.packBytes / 4, 'unchanged bulk objects are not resent');
    const sourced = changed.sourcePreparation.totalMs - changed.sourcePreparation.stages.cacheWaitMs;
    assert.ok(sourced < 1_000, `a job whose parent is warm sources in under 1 s, after any queue for the cache: ${sourced} ms ${JSON.stringify(changed.sourcePreparation)}`);
    assert.ok(Number.isSafeInteger(warm.executionPhases.sourceMs));
    // Bounded work, not elapsed time: warm and parent-held preparation reuse the base and resend no bulk history.
    assert.ok(Number.isSafeInteger(changed.executionPhases.sourceMs));
    assert.ok(changed.sourcePreparation.git.fetch.calls <= cold.sourcePreparation.git.fetch.calls + 1, 'parent-held preparation adds at most one delta fetch');
    assert.ok(warm.sourcePreparation.packBytes < cold.sourcePreparation.packBytes / 4, 'same-commit preparation resends no bulk history');
    assert.ok(Number.isSafeInteger(warm.executionPhases.commandMs));
    assert.ok(changed.sourcePreparation.git['merge-base']?.calls >= 1, 'ancestry of the origin base and tags is answered by merge-base --is-ancestor [C7]');
    // A cache repo with more than 8 packs is consolidated and given a commit-graph before the next job reads it.
    const cache = readdirSync(remoteHome, { recursive: true }).map(name => join(remoteHome, name))
      .find(name => /[\\/]repos[\\/][^\\/]+\.git$/u.test(name));
    assert.ok(cache, 'the runner kept a source cache repo');
    const packsIn = () => readdirSync(join(cache, 'objects', 'pack')).filter(name => name.endsWith('.pack')).length;
    for (let index = 0; index < 9; index++) {
      const written = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: cache, env, input: `extra pack object ${index}\n`, encoding: 'utf8' });
      spawnSync('git', ['pack-objects', join(cache, 'objects', 'pack', 'pack')], { cwd: cache, env, input: written.stdout });
    }
    assert.ok(packsIn() > 8, 'the fixture cache has accumulated more than 8 packs');
    await run('changed source\n', false, null, sourceTags);
    assert.ok(packsIn() <= 2, `the cache was repacked before the next job: ${packsIn()} packs left`);
    assert.ok(existsSync(join(cache, 'objects', 'info', 'commit-graph')) || existsSync(join(cache, 'objects', 'info', 'commit-graphs')), 'the cache has a commit-graph');
    git(repo, env, 'checkout', '--orphan', 'unrelated');
    git(repo, env, 'rm', '-rf', '.');
    writeFileSync(join(repo, 'pullboard.json'), JSON.stringify({ gate: 'true' }));
    writeFileSync(join(repo, 'tracked.txt'), 'unrelated source\n');
    git(repo, env, 'add', '.'); git(repo, env, 'commit', '-qm', 'test: unrelated source history');
    const unrelated = await run('unrelated source\n', false, base, []);
    assert.equal(unrelated.sourcePreparation.reusedCommit, null, 'an unrelated branch does not inherit a prior job repository');
    completed = true;
  } finally {
    held?.release();
    for (const [index, key] of ['PULLBOARD_HOME', 'PULLBOARD_MACHINE_HOME'].entries()) {
      if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    }
  }
});

test('batched source tag validation keeps Git ref rules and publishes no refs [C7]', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-source-tag-format-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_CONFIG_PARAMETERS']) delete env[key];
  git(dir, env, 'init', '--bare', '-q');
  const lease = { release() {} };
  /** Invoke actual Git unchanged so invalid names are rejected by the same parser as the worker. */
  const sourceGit = async (root, args, childEnv, input) => {
    const result = runFixtureChild('git', args, { cwd: root, env: childEnv, input, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.context);
    return result.stdout.trim();
  };
  /** Validate actual names without substituting a local imitation of Git rules. */
  const check = names => checkSourceTagNames({ cache: dir, tags: names.map(name => ({ name })), id: 'fixture-job',
    lease, git: sourceGit, env, objectLength: 40 });
  await check(['refs/tags/release-v1', 'refs/tags/nested/release', 'refs/tags/compass-🧭']);
  assert.equal(git(dir, env, 'for-each-ref'), '', 'the successful validation did not create refs');
  for (const name of ['refs/tags/bad..name', 'refs/tags/bad.lock', 'refs/tags/bad name', 'refs/tags/bad/']) {
    await assert.rejects(check([name]), undefined, `Git rejects ${name}`);
    assert.equal(git(dir, env, 'for-each-ref'), '', 'an invalid name did not publish partial refs');
  }
});
