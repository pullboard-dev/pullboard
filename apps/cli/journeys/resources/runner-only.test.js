/** @pullboard-test-input source-cell apps/cli packages/gate */
/** The native submit runner-only refusal case, apart from the registered-worker hang: refuses before the frozen body, and opt-out still runs it [C7,Q1,V4,#9692]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

/** Write only the machine policy the case needs, keeping the rest of the settings native setup produced. */
function policy(box, runnersOnly) {
  const file = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  writeFileSync(file, JSON.stringify({ ...previous, gateSlots: 1, browserSlots: 1, gate: { ...previous.gate, runnersOnly, runnerWaitMs: 80 } }));
}

/** Require native CLI success before using a result as setup evidence. */
function succeeded(result) {
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  return result;
}

test('cli.journeys-resources-runner-only.native-submit-runner-only-refuses-before: clause 1: native submit runner-only refuses before its frozen body and opt-out still executes it [C7,Q1,V4]', async () => {
  const box = helpers.project('true');
  const marker = join(box.dir, 'submit-frozen-body');
  const command = `printf ran > '${marker.replaceAll("'", "'\\''")}'`;
  const added = succeeded(await fixtureAdd(box.runLocal, box.repo, 'web', 'Private runner-only submission', '--specs', 'G1',
    '--criterion', 'The native frozen check remains mandatory.', '--check', command, '--wait', '--json'));
  const id = JSON.parse(added.out).item.item_id;
  succeeded(await box.runLocal(box.web, 'claim', String(id), '--json'));
  const committed = helpers.commitFile(box, box.web, 'web/runner-only.js', 'export const ready = true;\n', 'feat(web): private runner-only control [G1]');
  assert.equal(committed.status, 0, committed.failure ?? committed.stderr);
  // Native bar baseline setup may itself have run the command; it is not the subject submission.
  rmSync(marker, { force: true });
  policy(box, true);
  const refused = await box.runAsync(box.web, 'submit', String(id), '--wait', '--no-next', '--json');
  assert.notEqual(refused.code, 0, refused.out);
  assert.equal(JSON.parse(refused.out).error.code, 'RUNNER_WAIT_DEADLINE', refused.err || refused.out);
  assert.equal(existsSync(marker), false, 'no frozen or diagnostic local body ran');
  policy(box, false);
  succeeded(await box.runAsync(box.web, 'submit', String(id), '--wait', '--no-next', '--json'));
  assert.equal(readFileSync(marker, 'utf8'), 'ran', 'opt-out still runs the actual frozen check');
});
