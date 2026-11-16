/** A controlled flaky project ready to land: one submitted, accepted candidate and a private bare destination [C7,H16]. */
import {
  flakyProject,
  privateBuilder,
  commitCandidate,
  checkedItem,
} from '../../../../../packages/git/tests/fixtures/flakes.js';
import { runCliInProcess } from '../process.js';
import { whenRunnerSettles } from '../runner/local-start.js';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import {
  join,
} from 'node:path';

/** Run one public command in this process in the fixture's private environment; same receipt shape as the fixture's cliAt [C7]. */
export async function cliLocal(box, cwd, ...args) {
  const result = await runCliInProcess([...args, '--json'], { cwd, env: box.env });
  return { code: result.status, document: result.stdout?.trim() ? JSON.parse(result.stdout) : null, failure: null, stderr: result.stderr };
}

/** Prepare one genuinely submitted and accepted candidate with a private local bare destination. */
export async function readyLanding(t, rerun) {
  const box = flakyProject(t, { alwaysPass: 'controlled', rerun });
  const remote = join(box.scratch, 'private-origin.git');
  box.git('init', '-q', '--bare', remote);
  box.git('remote', 'add', 'origin', remote);
  box.git('push', '-q', '-u', 'origin', 'main');
  const id = checkedItem(box);
  const builder = privateBuilder(box);
  const claimed = await cliLocal(box, builder.root, 'claim', String(id));
  assert.equal(claimed.code, 0, JSON.stringify(claimed.document));
  commitCandidate(builder, 'chore: prepare controlled landing candidate');
  const submitted = await cliLocal(box, builder.root, 'submit', String(id));
  assert.equal(submitted.code, 0, JSON.stringify(submitted.document));
  // The submit is a pulled gate job: the item has its commit only once the machine's local runner posts the receipt [P7,C7].
  await whenRunnerSettles(box.env, async () => (await cliLocal(box, box.root, 'show', String(id))).document?.item_commit, { deadlineMs: 180_000, what: `the gate for #${id}` });
  const head = (await cliLocal(box, box.root, 'show', String(id))).document.item_commit;
  const reviewer = privateBuilder(box);
  reviewer.git('checkout', '-q', '--detach', head);
  const accepted = await cliLocal(box, reviewer.root, 'verify', String(id), 'accept', '--note', 'Private fixture: its exact controlled check passed before the external failure was armed.');
  assert.equal(accepted.code, 0, JSON.stringify(accepted.document));
  // Change the checked input on main so landing measures the merged tree instead of reusing the submit proof.
  const configFile = join(box.root, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.affectedTests = 'env -u NODE_TEST_CONTEXT node --test --test-reporter=tap';
  writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
  appendFileSync(join(box.root, 'test/alternating.test.mjs'), '\n// Advance the checked input on main.\n');
  box.git('add', 'pullboard.json', 'test/alternating.test.mjs');
  box.git('commit', '-q', '-m', 'test: advance controlled landing input');
  box.git('push', '-q', 'origin', 'main');
  const base = box.git('rev-parse', 'HEAD').trim();
  writeFileSync(box.counter, '');
  writeFileSync(box.counter + '.mode', 'paired');
  return { ...box, remote, base, id };
}

/** Wait for the offered land job's receipt to settle the item (a red returns it to its builder) and return the item's row [P7,C7]. */
export async function settleLand(box) {
  await whenRunnerSettles(box.env, async () => (await cliLocal(box, box.root, 'show', String(box.id))).document?.item_status !== 'verified', { deadlineMs: 180_000, what: `the land job for #${box.id}` });
  return (await cliLocal(box, box.root, 'show', String(box.id))).document;
}
