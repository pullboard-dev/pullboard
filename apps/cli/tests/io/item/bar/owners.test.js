/** With items.barRulesAtAdd on, add and edit judge lane ownership by the Files list alone, and the coordinator filing a lane item meets the rule [C7,#11777]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import * as store from '../../../../../../packages/store/index.js';
import { machineSettingsFile } from '../../../../../../packages/config/index.js';
import { cli } from '../../../fixtures/next/take.js';
import { fixture } from '../../../fixtures/next/take.js';

/** A file on main that no lane of the fixture owns: web owns web/, docs owns docs/. */
const READ_ONLY = 'vendor/cells/clock/index.js';

/** A board whose main holds the unowned file next to the web lane's own file, with items.barRulesAtAdd set as given (unset when undefined). */
async function board(t, rules, projectConfig = {}) {
  const box = await fixture(t, { projectConfig, files: { [READ_ONLY]: 'export const now = () => 0;\n', 'web/x.js': 'export const run = () => 1;\n' } });
  writeFileSync(machineSettingsFile(), JSON.stringify({ view: { background: false }, relay: { offerAtInit: false }, gate: { localRunner: false },
    ...(rules === undefined ? {} : { items: { barRulesAtAdd: rules } }) }));
  return box;
}

/** File one item from the main checkout as the coordinator, through the real CLI main(). */
function add(box, { criterion, files, lane = 'web', title = 'Clock page', extra = [] }) {
  const brief = `Files:\n${files.map(file => `- ${file}`).join('\n')}\nTest: the clock page renders\n`;
  return cli(box, box.root, ['add', lane, title, '--specs', 'G1', '--route', 'mid', '--criterion', criterion, '--check', 'false', '--brief', brief, ...extra]);
}

/** The refusal code a CLI run printed, or null when it exited 0. */
const refusal = result => (result.code === 0 ? null : result.document?.error?.code ?? `exit ${result.code}: ${result.out}${result.err}`);

test('cli.io-item-bar-owners.coordinator-filer-refused: clause 1: with items.barRulesAtAdd on, add and edit refuse CROSS_OWNERSHIP when the coordinator files a lane item whose Files list names an unowned path, and --split-coordinator still files both pieces [C7,#11777]', async t => {
  const box = await board(t, true);
  const criterion = `1. web/x.js renders [test]. 2. ${READ_ONLY} answers [test].`;
  const whole = await add(box, { criterion, files: ['web/x.js', READ_ONLY] });
  assert.equal(refusal(whole), 'CROSS_OWNERSHIP', whole.out + whole.err);
  assert.match(whole.document.error.message, /vendor\/cells\/clock\/index\.js/u);
  const split = await add(box, { criterion, files: ['web/x.js', READ_ONLY], extra: ['--split-coordinator'] });
  assert.equal(refusal(split), null, split.out + split.err);
  assert.equal(store.getItem(box.board, split.document.coordinatorPiece.item_id).item_lane, 'coordinator', 'the coordinator piece is filed too');
  const own = await add(box, { criterion: 'the clock answers', files: [READ_ONLY], lane: 'coordinator', title: 'Vendored clock cell answers the time' });
  assert.equal(refusal(own), null, 'a coordinator-lane item may name any path: ' + own.out + own.err);
  const plain = await add(box, { criterion: 'the clock page renders', files: ['web/x.js'], title: 'Plain web renderer for login screens' });
  assert.equal(refusal(plain), null, plain.out + plain.err);
  const edited = await cli(box, box.root, ['edit', String(plain.document.item.item_id), '--brief', `Files:\n- ${READ_ONLY}\nTest: the clock answers\n`]);
  assert.equal(refusal(edited), 'CROSS_OWNERSHIP', edited.out + edited.err);
});

test('cli.io-item-bar-owners.read-only-paths-filed: clause 2: with the setting on, a lane item whose criterion names an unowned path while its Files list names only its lane paths is filed with no refusal [C7,#11777]', async t => {
  const box = await board(t, true);
  const added = await add(box, { criterion: `the clock page renders by calling now() from ${READ_ONLY} unchanged`, files: ['web/x.js'] });
  assert.equal(refusal(added), null, added.out + added.err);
  assert.equal(store.getItem(box.board, added.document.item.item_id).item_lane, 'web');
});

test('cli.io-item-bar-owners.setting-off-unchanged: clause 3: with the setting off, add accepts the coordinator bar as today, and a coordinator-lane item may name any path [C7,#11777]', async t => {
  const box = await board(t, undefined, { laneMode: 'off' });
  const lane = await add(box, { criterion: 'the clock page renders', files: ['web/x.js', READ_ONLY] });
  assert.equal(refusal(lane), null, lane.out + lane.err);
  const own = await add(box, { criterion: 'the clock answers', files: [READ_ONLY], lane: 'coordinator', title: 'Vendored clock cell answers the time' });
  assert.equal(refusal(own), null, own.out + own.err);
});
