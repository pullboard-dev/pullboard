/** The slowest schema journey, alone in its file so the rest of the schema cases finish well inside the file budget [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { waitForCondition } from '../../../tests/fixtures/runner/holders.js';
import { runFixtureChild } from '../../../tests/fixtures/child.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';

import { copyPackageFiles } from '../../../../../packages/runners/index.js';
import { storeTriggers } from '../../../../../packages/state/index.js';
import { MACHINE } from '../../../../../packages/state/index.js';

import { SCHEMA_DIGEST } from '../../../../../packages/store/index.js';
import { SCHEMA_VERSION } from '../../../../../packages/store/index.js';
import { boardStanding } from '../../../../../packages/store/index.js';
import { recordSchemaStamp } from '../../../../../packages/store/index.js';
import { createSchemaFixture } from '../../../../../packages/store/tests/fixtures/schema-declaration.js';

const e2e = createE2eHelpers();
const { openRawBoard, olderDeclaration, observe, privateMainSource } = createSchemaFixture({
  MACHINE, storeTriggers, SCHEMA_DIGEST, SCHEMA_VERSION, boardStanding, recordSchemaStamp, copyPackageFiles });
after(e2e.cleanup);

/** Require a real private public command to succeed with its original diagnostics. */
async function succeeds(box, cwd, ...args) {
  const t0 = Date.now();
  const result = await box.runLocal(cwd, ...args);
  console.log(`TIMING ${args[0]} ${Date.now() - t0} ms`);
  assert.equal(result.code, 0, `${args.join(' ')}\n${result.out}\n${result.err}`);
  return result;
}

/** Commit one real source change in the private Git fixture. */
function choice(box, cwd, value) {
  const result = e2e.commitFile(box, cwd, 'web/feature.js', `export const choice = '${value}';\n`, 'feat(web): fixture choice [G1]');
  assert.equal(result.status, 0, result.stderr);
  return box.git(cwd, 'rev-parse', 'HEAD');
}

test('a stamped pre-carry board upgrades on main open and completes a native merge-only submission [M3,V1,V4,H16]', async () => {
  const T0 = Date.now();
  const box = e2e.project();
  console.log(`TIMING project ${Date.now() - T0} ms`);
  choice(box, box.repo, 'base');
  box.git(box.web, 'merge', '-q', '--no-edit', 'main');
  const added = await succeeds(box, box.repo, 'add', 'web', 'Carry after declaration upgrade', '--specs', 'G1',
    '--criterion', 'The unchanged acceptance survives a trunk-only merge', '--check', 'node --check web/feature.js', '--json');
  const id = JSON.parse(added.out).item.item_id;
  await succeeds(box, box.web, 'claim', String(id));
  const accepted = choice(box, box.web, 'accepted');
  await succeeds(box, box.web, 'submit', String(id));
  // A pulled submit returns queued; the item is submitted only once the gate job's receipt lands, so wait on the item itself [P7,C7].
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  await waitForCondition(() => observe(file).items.find(row => row.item_id === id)?.item_status === 'submitted', `the pulled gate submits #${id}`, { signal: AbortSignal.timeout(150_000) });
  box.git(box.repo, 'switch', '-q', '--detach', accepted);
  try { await succeeds(box, box.repo, 'verify', String(id), 'accept', '--as', 'coordinator', '--note', 'checked the accepted choice'); }
  finally { box.git(box.repo, 'switch', '-q', 'main'); }
  choice(box, box.repo, 'trunk');
  await succeeds(box, box.repo, 'reopen', String(id), '--conflict', 'web/feature.js');
  await succeeds(box, box.web, 'claim', String(id));
  assert.notEqual(box.tryGit(box.web, 'merge', '-q', '--no-edit', 'main').status, 0);
  const head = choice(box, box.web, 'resolved');
  olderDeclaration(file);
  const before = observe(file);
  await succeeds(box, box.repo, 'status');
  assert.deepEqual(observe(file), before, 'a public main read still does not migrate declarations');
  // The ordinary E2E CLI runs this agent's unmerged source, which correctly cannot own another
  // repository's shared DDL. Copy the actual candidate into a genuine private main source checkout.
  const application = join(box.dir, 'main-application');
  mkdirSync(application);
  const t1 = Date.now(); privateMainSource(box, application); console.log(`TIMING privateMainSource ${Date.now() - t1} ms`);
  // Process-level: this runs the copied candidate main checkout's own entry, which an in-process call cannot reach.
  console.log(`TIMING pre-open ${Date.now() - T0} ms`);
  const opened = runFixtureChild(process.execPath, [join(application, 'apps/cli/pullboard.js'), 'inbox', '--json'],
    { cwd: box.repo, env: box.env, encoding: 'utf8' });
  assert.equal(opened.status, 0, opened.stderr + opened.stdout);
  assert.ok(observe(file).schema.find(row => row.name === 'machine_item_move').sql.includes("'claimed>verified'"));
  await succeeds(box, box.web, 'submit', String(id));
  // The carry completes with the pulled gate job's receipt, which can land just after the settled command returns [P7,C7].
  await waitForCondition(() => observe(file).items.find(row => row.item_id === id)?.item_status === 'verified', `the pulled gate carries #${id}`, { signal: AbortSignal.timeout(150_000) });
  console.log(`TIMING total ${Date.now() - T0} ms`);
  const db = openRawBoard(file, { readOnly: true });
  try {
    const item = db.prepare('SELECT * FROM item WHERE item_id=?').get(id);
    assert.equal(item.item_status, 'verified');
    assert.equal(item.item_commit, head);
    assert.equal(db.prepare('SELECT count(*) AS n FROM verdict WHERE item_id=?').get(id).n, 1, 'carry retains the original reviewer verdict');
    assert.equal(db.prepare("SELECT count(*) AS n FROM event WHERE item_id=? AND event_kind='merge-only-accept'").get(id).n, 1);
  } finally { db.close(); }
});
