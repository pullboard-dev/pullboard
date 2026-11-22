/** @pullboard-test-input apps/cli/pullboard.js apps/cli/src/io/claim.js */
/** A check is sound before it freezes: with claim.checkCeiling on, add records a strict baseline and claim refuses a hidden or over-ceiling check [C7,#1273]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { onBoard } from '../../tests/fixtures/land/board.js';
import { fixtureMachineSettings } from '../../tests/fixtures/testkit.js';
import { frozenCheckCeilingMs } from '../../../../packages/config/index.js';
import { loadConfig } from '../../../../packages/config/index.js';
import * as store from '../../../../packages/store/index.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

const CHECK = 'node --test web/page.test.js';
const HIDDEN_CHECK = 'node --test web/page.test.js > /dev/null';

/** A project with claim.checkCeiling set as given and one open item added through the real CLI with `check`; its id and the box. */
async function filed(ceilingOn, check = CHECK) {
  const box = helpers.project();
  if (ceilingOn !== undefined) fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { claim: { checkCeiling: ceilingOn } });
  const added = await box.inProcess(box.repo, 'add', 'web', 'Soundness', '--criterion', '1. the page renders [test]', '--check', check, '--specs', 'G1', '--json');
  assert.equal(added.code, 0, added.err + added.out);
  return { box, id: JSON.parse(added.out).item.item_id };
}

/** Record a baseline for the item as an earlier measurement would have; `seconds` is in seconds. */
function record(box, id, baseline) {
  onBoard(box, board => store.saveCheckBaseline(board, id, { command: store.getItem(board, id).item_check, main: 'abc', ...baseline }));
}

const statusOf = (box, id) => onBoard(box, board => store.getItem(board, id).item_status);

test('cli.journeys-check-soundness.add-records-strict-baseline: clause 1: with claim.checkCeiling on, add --check records a pending baseline carrying strict true, and with it off the baseline has no strict field [C7,#1273]', async () => {
  const on = await filed(true);
  const strict = onBoard(on.box, board => store.getItem(board, on.id).item_check_baseline);
  assert.equal(strict.result, 'pending');
  assert.equal(strict.strict, true);
  const off = await filed(false);
  const plain = onBoard(off.box, board => store.getItem(board, off.id).item_check_baseline);
  assert.equal('strict' in plain, false);
});

test('cli.journeys-check-soundness.hidden-output-refused: clause 1: with claim.checkCeiling on, claim refuses CHECK_UNSOUND for a check that hides its output, and the item stays open [C7,#1273]', async () => {
  const { box, id } = await filed(false, HIDDEN_CHECK);
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { claim: { checkCeiling: true } });
  const refused = await box.runLocal(box.web, 'claim', String(id));
  assert.notEqual(refused.code, 0);
  assert.match(refused.err + refused.out, /CHECK_UNSOUND/u);
  assert.equal(statusOf(box, id), 'open');
});

test('cli.journeys-check-soundness.over-ceiling-refused: clause 1: with claim.checkCeiling on, claim refuses CHECK_OVER_CEILING for a check measured over the ceiling, and a sound strict check under it is claimed [C7,#1273]', async () => {
  const over = await filed(true);
  const ceilingSeconds = frozenCheckCeilingMs(loadConfig(over.box.repo)) / 1000;
  record(over.box, over.id, { result: 'green', strict: true, seconds: ceilingSeconds + 1 });
  const refused = await over.box.runLocal(over.box.web, 'claim', String(over.id));
  assert.notEqual(refused.code, 0);
  assert.match(refused.err + refused.out, /CHECK_OVER_CEILING/u);
  assert.equal(statusOf(over.box, over.id), 'open');
  const sound = await filed(true);
  record(sound.box, sound.id, { result: 'green', strict: true, seconds: 1 });
  const claimed = await sound.box.runLocal(sound.box.web, 'claim', String(sound.id));
  assert.equal(claimed.code, 0, claimed.err + claimed.out);
  assert.notEqual(statusOf(sound.box, sound.id), 'open');
});

test('cli.journeys-check-soundness.old-check-claims-while-pending: clause 2: with claim.checkCeiling on, an old non-strict check whose remeasure is pending is claimed [C7,#1273]', async () => {
  const { box, id } = await filed(true);
  const ceilingSeconds = frozenCheckCeilingMs(loadConfig(box.repo)) / 1000;
  onBoard(box, board => store.saveCheckBaseline(board, id, { command: store.getItem(board, id).item_check, main: 'abc', result: 'pending', seconds: ceilingSeconds + 1 }));
  const claimed = await box.runLocal(box.web, 'claim', String(id));
  assert.equal(claimed.code, 0, claimed.err + claimed.out);
  assert.notEqual(statusOf(box, id), 'open');
});

test('cli.journeys-check-soundness.setting-off-claims-as-today: clause 3: with claim.checkCeiling off or unset, a hidden-output check and an over-ceiling check are both claimed as today [C7,#1273]', async () => {
  for (const setting of [false, undefined]) {
    const hidden = await filed(setting, HIDDEN_CHECK);
    const claimedHidden = await hidden.box.runLocal(hidden.box.web, 'claim', String(hidden.id));
    assert.equal(claimedHidden.code, 0, `hidden, setting ${setting}: ${claimedHidden.err}${claimedHidden.out}`);
    const over = await filed(setting);
    record(over.box, over.id, { result: 'green', seconds: frozenCheckCeilingMs(loadConfig(over.box.repo)) / 1000 + 1 });
    const claimedOver = await over.box.runLocal(over.box.web, 'claim', String(over.id));
    assert.equal(claimedOver.code, 0, `over, setting ${setting}: ${claimedOver.err}${claimedOver.out}`);
  }
});
