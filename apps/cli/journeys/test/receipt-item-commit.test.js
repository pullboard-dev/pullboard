/** @pullboard-test-loads apps/cli/src/io/commands/test.js */
/** @pullboard-test-loads packages/drive/src/io/queue.js */
/** @pullboard-test-loads packages/store/src/io/receipts.js */
/** A green pullboard test run records a proof-run naming its item and commit, and show lists it [C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  pullProject,
  pullQueue,
  serveOnce,
} from '../../tests/fixtures/pull.js';

const REPO = resolve(import.meta.dirname, '../../../..');
const BIN = resolve(import.meta.dirname, '../../pullboard.js');
/** Accepted main's TAP reader, the one the gate entry imports to name failing cases. */
const LIGHT = `export { tapFailures } from ${JSON.stringify(pathToFileURL(join(REPO, 'packages/gate/light.js')).href)};\n`;
const PASSES = "import { test } from 'node:test';\ntest('passes', () => {});\n";

/**
 * A pull project (gate.runnerDispatch pull, claims.perSeat 2 for the two items) whose main carries one green test file,
 * merged into the web seat. A pulled test job is served by a real runner process the journey starts itself.
 */
async function runnerProject(t) {
  const box = await pullProject(t, 2, { tooling: { 'packages/gate/light.js': LIGHT } });
  const configFile = join(box.repo, 'pullboard.json');
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), affectedTests: 'node --test' }, null, 2) + '\n');
  mkdirSync(join(box.repo, 'test'));
  writeFileSync(join(box.repo, 'test/ok.test.js'), PASSES);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'test: one green file');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  return { box, queue: await pullQueue(t, box) };
}

test('clause 1 and 2: a green run with --item N records a proof-run naming N and the head sha, and show N lists it [C7]', { timeout: 240_000 }, async t => { // budget: hang ceiling for one project, one runner process and one test job.
  const { box, queue } = await runnerProject(t);
  for (const id of box.ids) {
    const claimed = await box.runAsync(box.web, 'claim', String(id));
    assert.equal(claimed.code, 0, `claim ${id}: ${claimed.out}${claimed.err}`);
  }
  const [first, second] = box.ids;
  const head = box.git(box.web, 'rev-parse', 'HEAD').trim();
  // Under pull the seat offers the test job and waits; a runner process the journey starts serves it and its receipt names the item.
  const seat = box.helpers.launch(box, box.web, process.execPath, [BIN, 'test', '--wait', 'test/ok.test.js', '--item', String(second)]);
  const served = await serveOnce(box, queue.url, 'r-item');
  assert.equal(served.code, 0, served.output);
  const ran = await seat.closed;
  assert.equal(ran.code, 0, `the green run exits 0: ${seat.stdoutText}${seat.stderrText}`);
  const refused = await box.runAsync(box.web, 'test', '--wait', 'test/ok.test.js', '--item', '9999');
  assert.match(refused.err + refused.out, /NOT_YOURS/u, 'an item the seat does not hold is refused');
  const shown = await box.runAsync(box.web, 'show', String(second));
  assert.match(shown.out, /receipt [0-9a-f-]{36}: check, item #\d+/u, `show lists the receipt: ${seat.stderrText}${seat.stdoutText} ${shown.out.slice(0, 300)}`);
  assert.match(shown.out, new RegExp(`commit ${head}`, 'u'), 'the receipt names the head sha');
  const other = await box.runAsync(box.web, 'show', String(first));
  assert.doesNotMatch(other.out, /receipt [0-9a-f-]{36}: check/u, 'the claim --item did not name gets no receipt');
});
