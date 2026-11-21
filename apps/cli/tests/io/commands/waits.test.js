/** The waits command files only this board's waits [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { FIXTURE_MODEL } from '../../fixtures/testkit.js';
import { cli } from '../../fixtures/next/take.js';
import { fixture } from '../../fixtures/next/take.js';

const MINUTE = 60_000;

/** Make one aged machine-wide runner row for this fixture's deterministic clock. */
function unavailable(box, host) {
  mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  const db = new DatabaseSync(join(process.env.PULLBOARD_MACHINE_HOME, 'resources.sqlite'));
  db.exec("CREATE TABLE IF NOT EXISTS runner_unavailable (host TEXT PRIMARY KEY, since TEXT, detail TEXT DEFAULT '')");
  db.prepare('INSERT OR REPLACE INTO runner_unavailable (host, since, detail) VALUES (?, ?, ?)')
    .run(host, new Date(box.clock.now().getTime() - 20 * MINUTE).toISOString(), 'CLEANUP_UNVERIFIED');
  db.close();
}

/** The fresh-board fixture exposes only C7 and a core lane for the item's filing checks. */
const coreBoard = { projectConfig: { lanes: { core: { owns: ['apps/'] } } }, files: { 'SPEC.md': '# Fixture\n## C\n- C7 [approved, must] Work keeps its evidence. | gate: true\n' } };

test('cli.io-commands-waits.fresh-board-files-nothing: clause 1: pullboard waits record after init ignores a runner-unavailable host with no board job [test] [C7]', async t => {
  const box = await fixture(t, coreBoard);
  const joined = await cli(box, box.root, ['join', 'core', '--model', FIXTURE_MODEL]);
  assert.equal(joined.code, 0, joined.out + joined.err);
  unavailable(box, 'other-board-host');
  const itemCount = () => box.board.db.prepare('SELECT COUNT(*) AS n FROM item').get().n;
  const before = itemCount();
  const recorded = await cli(box, box.root, ['waits', 'record']);
  assert.equal(recorded.code, 0, recorded.out + recorded.err);
  assert.equal(itemCount(), before, 'a runner row of another board host files no item');
});

test('cli.io-commands-waits.own-runner-filed-in-own-lane: clause 2: waits record files a used runner wait in this board core lane with its C7 row [test] [C7]', async t => {
  const box = await fixture(t, coreBoard);
  const joined = await cli(box, box.root, ['join', 'core', '--model', FIXTURE_MODEL]);
  assert.equal(joined.code, 0, joined.out + joined.err);
  const now = box.clock.now().getTime();
  box.board.db.prepare('INSERT INTO job (job_id, job_kind, job_item, job_step, job_created, job_updated) VALUES (?, ?, ?, ?, ?, ?)')
    .run('gate-owned-host', 'gate', null, 'done', now, now);
  box.board.db.prepare('INSERT INTO job_step (job_step_job, job_step_name, job_step_payload, job_step_at) VALUES (?, ?, ?, ?)')
    .run('gate-owned-host', 'result', JSON.stringify({ runner: 'owned-host' }), now);
  unavailable(box, 'owned-host');
  const before = box.board.db.prepare('SELECT COUNT(*) AS n FROM item').get().n;
  const recorded = await cli(box, box.root, ['waits', 'record']);
  assert.equal(recorded.code, 0, recorded.out + recorded.err);
  const items = box.board.db.prepare('SELECT item_title, item_lane, item_criterion FROM item').all();
  assert.equal(items.length, before + 1, 'the board-used host files one item');
  assert.equal(items.at(-1).item_lane, 'core');
  assert.match(items.at(-1).item_criterion, /C7/u);
});
