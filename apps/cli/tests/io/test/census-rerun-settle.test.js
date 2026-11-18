/** With census.rerunOnSettle on, a census reruns a non-green file the moment its job settles, under the 3-minute file kill [C7,#9283]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rmSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { fixtureCommitAll } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { fixtureMachineSettings } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { runCensus } from '../../../src/io/test/census.js';

const FILES = ['one.test.js', 'two.test.js'];
const quiet = { err() {}, say() {}, result() {} };

/** A private clean repo tracking two test files, and a machine home with the given settings. */
function fixture(t, settings) {
  const box = privateFixtureFiles('pullboard-census-settle-');
  const repo = join(box.root, 'repo');
  const home = join(box.root, 'machine-home');
  mkdirSync(repo);
  mkdirSync(home);
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; rmSync(box.root, { recursive: true, force: true }); });
  fixtureMachineSettings(home, settings);
  for (const file of FILES) box.write(`repo/${file}`, "import { test } from 'node:test';\ntest('x', () => {});\n");
  fixtureCommitAll(repo);
  return repo;
}

/**
 * A dispatcher for a two-job census whose files are red in their own job and green on rerun. Job 1 posts at once; job 2
 * posts only after `hold` is released, which the test releases when it chooses. `events` records the order of posts and reruns.
 */
function dispatcher(events, args, release) {
  return async (call) => {
    const { files, write, count } = call;
    args.push(call);
    if (count === 1) {
      events.push(`rerun ${files.join(',')}`);
      write('# landing shard 1/1 attempt 1 on rerun-host: green in 100 ms\n');
      write(`${files.map(file => `# landing-file-ms 100 ${file}\n# landing-file-exit 0 ${file}`).join('\n')}\n# tests 1\n# pass 1\n`);
      write('# landing result: done\n');
      return { isGreen: true };
    }
    const post = async (label) => {
      events.push(`post ${label}`);
      write(`# landing shard ${label} attempt 1 on host-${label[0]}: red in 9000 ms\n`);
      write(`${files.map(file => `# landing-file-ms 1500 ${file}\n# landing-file-exit 1 ${file}`).join('\n')}\n# tests 2\n# pass 0\n# fail 2\n`);
    };
    await post('1/2');
    await release();
    await post('2/2');
    write('# landing result: done\n');
    return { isGreen: false };
  };
}

/** Run a two-job census; `release` decides what job 2 waits for. */
async function census(t, settings, wait) {
  const repo = fixture(t, settings), events = [], args = [];
  let rerunSeen;
  const seen = new Promise((resolve) => { rerunSeen = resolve; });
  const base = dispatcher(events, args, () => wait(seen));
  const run = async (call) => { const ran = base(call); if (call.count === 1) rerunSeen(); return ran; };
  await runCensus(quiet, { info: { root: repo } }, { 'no-file-limit': true, out: join(repo, '..', 'census.jsonl') }, { shards: 2, run });
  return { events, args };
}

test('cli.io-test-census-rerun-settle.with-census-rerunonsettle-on-the-rerun-is: clause 1: with census.rerunOnSettle on, the rerun is offered before the other pass-1 job posts [C7,#9283]', async (t) => {
  // Job 2 waits for a rerun to be offered; if reruns waited for the whole pass this would never release.
  const { events } = await census(t, { census: { rerunOnSettle: true } }, seen => Promise.race([seen, new Promise(resolve => setTimeout(resolve, 3000))]));
  assert.ok(events.indexOf('post 1/2') < events.findIndex(event => event.startsWith('rerun')), 'a rerun follows its job');
  assert.ok(events.findIndex(event => event.startsWith('rerun')) < events.indexOf('post 2/2'), `the rerun came before job 2 posted: ${events.join(' | ')}`);
});

test('cli.io-test-census-rerun-settle.the-settle-rerun-carries-the-3-minute: clause 2: the settle rerun carries the 3-minute file kill, not the 10-minute hard stop [C7,#9283]', async (t) => {
  const { args } = await census(t, { census: { rerunOnSettle: true } }, seen => Promise.race([seen, new Promise(resolve => setTimeout(resolve, 3000))]));
  const first = args.find(call => call.count !== 1), reruns = args.filter(call => call.count === 1);
  assert.ok(reruns.length >= 1);
  assert.notEqual(first.fileLimit, false, 'the first pass keeps the no-file-limit flag');
  for (const call of reruns) assert.equal(call.fileLimit, false, 'a settle rerun asks for the usual per-file kill');
});

test('cli.io-test-census-rerun-settle.with-census-rerunonsettle-off-reruns-still-wait: clause 3: with census.rerunOnSettle off, reruns still wait for the whole pass [C7,#9283]', async (t) => {
  const { events } = await census(t, { census: { rerunNonGreen: true } }, async () => {});
  assert.ok(events.indexOf('post 2/2') < events.findIndex(event => event.startsWith('rerun')), `the reruns came after both jobs posted: ${events.join(' | ')}`);
});
