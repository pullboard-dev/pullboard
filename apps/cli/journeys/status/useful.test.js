/** Status prints the max useful builder count with its window and inputs, and says unknown when too little was observed [C7,#8544]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureSettledMachine } from '../../../../packages/gate/tests/fixtures/testkit.js';
import { fixtureProjectPolicy } from '../../../../packages/gate/tests/fixtures/testkit.js';
import { withFixtureBoard } from '../../tests/fixtures/board.js';

const HOUR = 3_600_000;
const helpers = createE2eHelpers();
test.after(helpers.cleanup);

/** A real private Git/SQLite project whose board holds the seeded events; returns the printed status. */
async function statusAfter(seed, settings = { status: { showUsefulBuilders: true } }) {
  const box = helpers.sandbox();
  const root = join(box.dir, 'repo');
  mkdirSync(root);
  box.git(root, 'init', '-q', '-b', 'main');
  fixtureProjectPolicy(root, { config: { ...helpers.CONFIG, gate: 'true' }, spec: '# Spec\n\n## B · Board\n- B1 [approved, must] A row. | gate: test\n' });
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, settings);
  assert.equal(box.runSync(root, 'init').code, 0);
  box.git(root, 'add', '-A');
  box.git(root, 'commit', '-q', '-m', 'chore(fixture): initialize');
  withFixtureBoard(join(root, '.git', 'pullboard', 'board.sqlite'), board => {
    const put = (kind, by, at) => board.db.prepare("INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, 1, '{}')").run(new Date(at).toISOString(), by, kind);
    seed(put);
  });
  return box.runIn(root, 'status');
}

test('cli.journeys-status-useful.status-prints-the-max-useful-builder: clause 1: status prints the max useful builder number with its window and inputs instead of unknown [C7,#8544]', async () => {
  const base = Math.floor((Date.now() - 24 * HOUR) / HOUR) * HOUR;
  const status = await statusAfter(put => {
    put('claim', 'core-1', base + 600_000);
    for (const seat of ['core-1', 'core-2', 'core-3']) put('claim', seat, base + HOUR + 300_000);
    for (let i = 0; i < 4; i += 1) put('merged', 'board', base + HOUR + 1_800_000 + i * 60_000);
  });
  assert.equal(status.code, 0, status.err);
  assert.match(status.out, /^Max useful builders: 3 \(window \d{4}-\d\d-\d\d to \d{4}-\d\d-\d\d; 2 observed hours at seat counts 1, 3\)\.$/m);
  assert.doesNotMatch(status.out, /^Max useful builders: unknown/m);
});

test('cli.journeys-status-useful.status-says-unknown-with-the-observed: clause 1: status says unknown, with the observed inputs, when fewer than two seat counts were seen [C7,#8544]', async () => {
  const status = await statusAfter(() => {});
  assert.equal(status.code, 0, status.err);
  assert.match(status.out, /^Max useful builders: unknown \(needs two observed seat counts; window \S+ to \S+; \d+ observed hours at seat counts [^)]*\)\.$/m);
});

test('cli.journeys-status-useful.status-showusefulbuilders-off-the-default-leaves: clause 1: status.showUsefulBuilders off, the default, leaves the line out of status [C7,#8544]', async () => {
  const status = await statusAfter(() => {}, {});
  assert.equal(status.code, 0, status.err);
  assert.doesNotMatch(status.out, /Max useful builders/u);
});
