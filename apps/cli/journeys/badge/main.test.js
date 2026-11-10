import { requireFixtureReviewFamilies } from "../../tests/fixtures/review/family.js";
/** Board-record badge counts use actual private Git/SQLite projects [B3,V1]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import * as store from "../../../../packages/store/src/io/board.js";
import { openCellBoard as openBoard } from "../../../../packages/store/tests/fixtures/cell.js";
import { exportBoard } from "../../../../packages/store/index.js";
import { importBoard } from "../../../../packages/store/index.js";
import { createE2eHelpers } from "../../tests/fixtures/e2e.js";
import { assertBadgeLanding } from "../../tests/fixtures/badge.js";
import { submitFixture } from "../../tests/fixtures/board/submit.js";

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** Seed historical board records through normal lifecycle and native import, including a legacy self acceptance. */
function badgeProject(total, outside, { independent = outside } = {}) {
  const box = e2e.sandbox();
  box.git(box.dir, 'init', '-q', '-b', 'main');
  const source = openBoard(':memory:');
  let document;
  try {
    store.register(source, { lane: 'coordinator', path: box.dir });
    const builder = store.register(source, { lane: 'web', path: join(box.dir, 'builder'), family: 'Fixture Badge Builder Vendor', parent: 'badge-parent-P' });
    const reviewer = store.register(source, { lane: 'web', path: join(box.dir, 'reviewer'), family: 'Fixture Badge Reviewer Vendor', parent: 'badge-parent-Q' });
    const procedural = store.register(source, { lane: 'web', path: join(box.dir, 'procedural-reviewer'), family: 'Fixture Badge Procedural Vendor' });
    requireFixtureReviewFamilies(source);
    for (let index = 0; index < total; index++) {
      const id = store.addItem(source, { by: 'coordinator', lane: 'web', title: `Finished ${index}` });
      store.claim(source, id, { agentId: builder, lane: 'web', leaseMs: 3_600_000,
        freeze: () => ({ text: 'badge history fixture', digest: `badge-${id}` }) });
      const commit = String(index + 1).padStart(40, '0');
      submitFixture(source, id, { agentId: builder, commit, tree: commit });
      store.verify(source, id, { agentId: index < independent ? reviewer : procedural, decision: 'ACCEPT', head: commit,
        digest: `badge-${id}`, policy: 'any', note: 'Synthetic historical board-state acceptance; no runtime proof claimed.' });
    }
    document = exportBoard(source);
    // Modern guards forbid self acceptance; native import preserves historical records without a guard bypass.
    for (const item of document.tables.item.slice(outside)) {
      item.item_verified_by = builder;
      for (const verdict of document.tables.verdict.filter(row => row.item_id === item.item_id)) verdict.verdict_by = builder;
    }
  } finally { store.closeBoard(source); }
  const target = openBoard(join(box.dir, '.git', 'pullboard', 'board.sqlite'));
  try { importBoard(target, document); } finally { store.closeBoard(target); }
  const initialized = box.run(box.dir, 'init');
  assert.equal(initialized.code, 0, initialized.err);
  return box;
}

/** Read the committed endpoint shape written by the real command. */
function endpoints(box) {
  return ['items', 'checked'].map(name => JSON.parse(readFileSync(join(box.dir, `docs/badges/${name}.json`), 'utf8')));
}

test('pullboard badge writes the verified counts from the board [B3,V1]', () => {
  const five = badgeProject(5, 4);
  const result = five.run(five.dir, 'badge', '--json');
  assert.equal(result.code, 0, `${result.err}\n${result.out}`);
  assert.deepEqual(endpoints(five), [
    { schemaVersion: 1, label: 'pullboard', message: '5 items', color: '2f7d5b' },
    { schemaVersion: 1, label: 'agent-verified', message: '80%', color: '6e7781' },
  ]);
  const repeated = five.run(five.dir, 'badge', '--json');
  assert.equal(repeated.code, 0, repeated.err);
  assert.deepEqual(JSON.parse(repeated.out).changed, [], 'unchanged counts do not rewrite the documents');
  const thirds = badgeProject(3, 2);
  assert.equal(thirds.run(thirds.dir, 'badge').code, 0);
  assert.equal(endpoints(thirds)[1].message, '66%', 'the percentage is floored, never rounded');
  const empty = badgeProject(0, 0);
  const nothing = empty.run(empty.dir, 'badge');
  assert.equal(nothing.code, 0, nothing.err);
  assert.match(nothing.out, /No finished items.*no badge files/);
  assert.equal(existsSync(join(empty.dir, 'docs/badges')), false, 'no files or directories are written for no finished work');
  assertBadgeLanding(e2e);
});


test('[V1,B3] procedural verdicts do not increase the independent badge percentage', () => {
  const mixed = badgeProject(3, 3, { independent: 2 });
  assert.equal(mixed.run(mixed.dir, 'badge').code, 0);
  assert.equal(endpoints(mixed)[1].message, '66%', 'unknown-parent procedural acceptance stays in the denominator only');
  const unknown = badgeProject(3, 3, { independent: 0 });
  assert.equal(unknown.run(unknown.dir, 'badge').code, 0);
  assert.equal(endpoints(unknown)[1].message, '0%', 'three different-seat acceptances with unknown reviewer parents prove no independent percentage');
});
