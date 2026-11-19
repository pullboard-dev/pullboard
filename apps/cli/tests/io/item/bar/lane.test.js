/** With items.barRulesAtAdd on, add and edit refuse a bar naming a file another lane owns, LANE_FOREIGN_PATH [C7,#11739]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import * as store from '../../../../../../packages/store/index.js';
import { machineSettingsFile } from '../../../../../../packages/config/index.js';
import { cli } from '../../../fixtures/next/take.js';
import { fixture } from '../../../fixtures/next/take.js';

/** Main holds web/x.js (the web lane's) and docs/spec.md (the docs lane's). */
const FILES = { 'web/x.js': 'export const x = 1;\n', 'docs/spec.md': '# Spec\n' };
const BRIEF = 'Files:\n- web/x.js\nTest: the web page renders\n';
const OWN = 'the web page reads web/x.js';
const FOREIGN = 'the web page reads docs/spec.md';

/** Turn items.barRulesAtAdd on or off in this fixture's machine settings. */
function rules(on) {
  mkdirSync(machineSettingsFile().replace(/\/[^/]+$/u, ''), { recursive: true });
  writeFileSync(machineSettingsFile(), JSON.stringify({ view: { background: false }, relay: { offerAtInit: false }, gate: { localRunner: false }, items: { barRulesAtAdd: on } }));
}

/** File a web item through the real CLI as the given seat folder. */
/** Titles that share no words, so the duplicate guard never reads one add as another. */
const TITLES = ['Quartz lantern', 'Harbor meadow', 'Copper tundra', 'Velvet orchard', 'Saffron glacier'];
let filed = 0;
const add = (box, cwd, criterion) => cli(box, cwd, ['add', 'web', TITLES[filed++ % TITLES.length], '--specs', 'G1', '--route', 'strong', '--criterion', criterion, '--brief', BRIEF]);

test('cli.io-item-bar-lane.foreign-path-refused: clause 1: with items.barRulesAtAdd on, add and edit by a web seat refuse a bar naming docs/spec.md, a docs-lane file on main, LANE_FOREIGN_PATH naming the path and the lane [C7,#11739]', async t => {
  const box = await fixture(t, { files: FILES });
  rules(true);
  const added = await add(box, box.seats.actor.path, FOREIGN);
  assert.equal(added.code, 1, added.out + added.err);
  assert.equal(added.document.error.code, 'LANE_FOREIGN_PATH', added.out);
  assert.match(added.document.error.message, /docs\/spec\.md \(docs's\)/u);
  const good = await add(box, box.seats.actor.path, OWN);
  assert.equal(good.code, 0, good.out + good.err);
  const id = good.document.item.item_id;
  const edited = await cli(box, box.seats.actor.path, ['edit', String(id), '--criterion', FOREIGN]);
  assert.equal(edited.code, 1, edited.out + edited.err);
  assert.equal(edited.document.error.code, 'LANE_FOREIGN_PATH', edited.out);
  assert.match(edited.document.error.message, /docs\/spec\.md/u);
  assert.equal(store.getItem(box.board, id).item_criterion, OWN, 'the refused edit leaves the bar as it was');
});

test('cli.io-item-bar-lane.refusal-names-alternative: clause 2: the refusal next step names the owning lane to file it in, and the split into the web piece and the docs piece filed --after it [C7,#11739]', async t => {
  const box = await fixture(t, { files: FILES });
  rules(true);
  const added = await add(box, box.seats.actor.path, FOREIGN);
  assert.equal(added.document.error.code, 'LANE_FOREIGN_PATH', added.out);
  const next = String(added.document.error.next ?? '');
  assert.match(next, /file it in the owning lane \(docs\)/u);
  assert.match(next, /web piece and the docs piece filed with --after/u);
});

test('cli.io-item-bar-lane.off-or-own-lane-accepted: clause 3: with the setting off, or a bar naming only the item lane files, add accepts the bar as today [C7,#11739]', async t => {
  const box = await fixture(t, { files: FILES });
  rules(false);
  const off = await add(box, box.seats.actor.path, FOREIGN);
  assert.equal(off.code, 0, off.out + off.err);
  rules(true);
  const own = await add(box, box.seats.actor.path, OWN);
  assert.equal(own.code, 0, own.out + own.err);
  const coordinator = await add(box, box.root, FOREIGN);
  assert.equal(coordinator.code, 0, 'the coordinator may name any path: ' + coordinator.out + coordinator.err);
});
