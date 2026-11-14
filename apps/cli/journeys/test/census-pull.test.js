/** @pullboard-test-loads apps/cli/src/io/test/census.js */
/** On a pull board `pullboard test --census` offers its shards as pulled test jobs a runner takes, never controller custody in its own process [C7,#7602]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { jobsOf } from '../../../../packages/jobs/index.js';
import { pullProject } from '../../tests/fixtures/pull.js';
import { pullQueue } from '../../tests/fixtures/pull.js';
import { serveOnce } from '../../tests/fixtures/pull.js';

const REPO = resolve(import.meta.dirname, '../../../..');
const BIN = resolve(import.meta.dirname, '../../pullboard.js');

/** Accepted main's TAP reader, the one the test job's entry imports to name failing cases. */
const LIGHT = `export { tapFailures } from ${JSON.stringify(pathToFileURL(join(REPO, 'packages/gate/light.js')).href)};\n`;

/** A test file that notes it ran and where, so the census is seen running every file on the runner. */
const PASS = name => `import { appendFileSync } from 'node:fs';
import { test } from 'node:test';
test('${name} passes', () => { appendFileSync(process.env.PULLBOARD_FIXTURE_STEPS, JSON.stringify({ step: 'test', file: '${name}', cwd: process.cwd() }) + '\\n'); });
`;

test('clause 1: pullboard test --census on a pull board runs every file as a pulled shard job on a local runner, with no controller custody error [C7]', { timeout: 180_000 }, // budget: hang ceiling for a project, one census job and one runner process.
async t => {
  const box = await pullProject(t, 1, { tooling: { 'packages/gate/light.js': LIGHT } });
  const config = join(box.repo, 'pullboard.json');
  writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')), affectedTests: 'node --test' }, null, 2) + '\n');
  mkdirSync(join(box.repo, 'census'), { recursive: true });
  const files = ['one', 'two', 'three'].map(name => `census/${name}.test.js`);
  for (const file of files) writeFileSync(join(box.repo, file), PASS(file));
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: three census files [G1]');
  const queue = await pullQueue(t, box);
  const out = join(box.runnerHome, 'census.jsonl'), steps = join(box.runnerHome, 'steps.jsonl');
  const census = box.helpers.launch(box, box.repo, process.execPath, [BIN, 'test', '--census', '--out', out, 'census/']);
  const served = await serveOnce(box, queue.url, 'r-census', { PULLBOARD_FIXTURE_STEPS: steps });
  assert.equal(served.code, 0, served.output);
  const done = await census.closed;
  assert.doesNotMatch(census.stderrText, /controller custody/u, 'the census takes no controller custody');
  assert.equal(done.code, 0, `${census.stderrText}\n${census.stdoutText}`);
  assert.match(census.stdoutText, /census of 3 files at [0-9a-f]{10} in \d+s over 1 shards: 3 green/u);

  const rows = readFileSync(out, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => [row.file, row.status, row.host]).sort(), files.map(file => [file, 'green', 'r-census']).sort(), 'one green row per file, from the runner that ran it');
  const ran = readFileSync(steps, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(ran.map(entry => entry.file).sort(), [...files].sort(), 'every file ran once');
  assert.ok(ran.every(entry => entry.cwd.includes(join('r-census', 'work'))), 'each file ran in the runner\'s checkout');
  const jobs = jobsOf(queue.board.db, { kind: 'test' });
  assert.equal(jobs.length, 1, 'the one shard was one pulled test job');
  assert.equal(jobs[0].step, 'done');
  assert.equal(box.git(box.repo, 'for-each-ref', 'refs/pullboard/test'), '', 'the pin is dropped once the receipt is in');
});
