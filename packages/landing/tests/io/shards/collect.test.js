/** @pullboard-test-input packages/landing/src/io/shards.js */
/** A landing run that collects every failure still finishes the other files when one file is red, and reports its collection complete [B3,C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { runLandingShards } from '../../../index.js';
import { LANDING_COLLECT_ALL_ENV } from '../../../index.js';
import { formatCollectionReport } from '../../../../gate/heavy.js';
import { parseCollectionReports } from '../../../../gate/heavy.js';
import { COLLECTION_ID_ENV } from '../../../../gate/heavy.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { runFixtureSetupGit } from '../../../../gate/tests/fixtures/child.js';

const ID = '11111111-2222-4333-8444-555555555555';
const FILES = ['test/a.test.js', 'test/b.test.js'];

/** A committed project holding the two test files, so the landing pins a real source. */
function project(t) {
  const files = privateFixtureFiles('pullboard-collect-all-');
  t.after(() => rmSync(files.root, { recursive: true, force: true }));
  for (const file of FILES) files.write(file, "import { test } from 'node:test';\ntest('x', () => {});\n");
  const env = { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'f@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'f@example.invalid' }, cwd: files.root };
  for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['commit', '-q', '-m', 'fixture']]) runFixtureSetupGit(args, env);
  return files.root;
}

/** Run one landing shard holding both files through a runner stand-in whose run is red for `b`, with collect-all on or off. */
async function landing(t, collectAll) {
  const root = project(t);
  const saved = { all: process.env[LANDING_COLLECT_ALL_ENV], id: process.env[COLLECTION_ID_ENV] };
  process.env[LANDING_COLLECT_ALL_ENV] = collectAll ? '1' : '0';
  process.env[COLLECTION_ID_ENV] = ID;
  t.after(() => {
    for (const [key, value] of [[LANDING_COLLECT_ALL_ENV, saved.all], [COLLECTION_ID_ENV, saved.id]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const log = [];
  const commands = [];
  const remoteRun = async (_root, command) => {
    commands.push(command);
    const report = formatCollectionReport({ id: ID, scope: 'shard', shard: '1/1', plannedFiles: FILES, completedFiles: FILES, complete: true, cleanupVerified: true });
    return { isGreen: false, output: `ok - a\nnot ok - b\n${report}` };
  };
  const result = await runLandingShards({ root, runner: 'apps/cli/src/io/run/tests.js', files: FILES, count: 1, inherited: { runner: { host: 'runner-a' }, source: {} },
    needsBrowser: async () => false, needsGui: async () => false, parseProcessCensus: () => [], runnerAdmission: {}, remoteRun, write: text => log.push(text) });
  return { result, log: log.join(''), commands };
}

test('landing.collect.with-collect-all-on-a-red: clause 1: with collect-all on, a red file leaves the run red but collected, every file accounted and the suite collection complete [B3,C7]', async t => {
  const { result, log, commands } = await landing(t, true);
  assert.equal(result.isGreen, false);
  assert.match(commands[0], /PULLBOARD_LANDING_COLLECT_ALL=1/u, 'the shard is told to collect every failure');
  assert.match(log, /# landing result: red, 1 failing shard\(s\); all test shards collected/u);
  assert.doesNotMatch(log, /first failure in shard/u, 'a collected red is not the first-failure stop');
  const suite = parseCollectionReports(log, { id: ID, scope: 'suite', requireComplete: true });
  assert.ok(suite, 'the suite collection report is complete');
  assert.deepEqual(suite.completedFiles, FILES, 'both files, the red one included, are accounted');
  assert.equal(result.full, true);
  assert.deepEqual(result.shards.map(shard => shard.status), ['red']);
});

test('landing.collect.with-collect-all-off-the-same: clause 1: with collect-all off, the same red file ends the run at its first failure and prints no collection report [B3,C7]', async t => {
  const { result, log, commands } = await landing(t, false);
  assert.equal(result.isGreen, false);
  assert.match(commands[0], /PULLBOARD_LANDING_COLLECT_ALL=0/u);
  assert.match(log, /# landing result: red, first failure in shard 1\/1/u);
  assert.equal(parseCollectionReports(log, { id: ID, scope: 'suite', requireComplete: false }), null);
});
