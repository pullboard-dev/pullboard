/** add and edit refuse a check that passes with no tests before its test file exists, behind items.barRulesAtAdd [C7,#11779]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { requireNonEmptyCheck } from '../../../../src/io/item/bar.js';
import { createE2eHelpers } from '../../../fixtures/e2e.js';
import { fixtureAdd } from '../../../fixtures/testkit.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

const PRESENT = 'web/tests/present.test.js';
const ABSENT = 'web/tests/absent.test.js';

/** A fixture repo whose main holds one test file, returned with the context the bar check reads. */
function mainWithTest() {
  const box = helpers.project('true', helpers.sandbox());
  mkdirSync(dirname(join(box.repo, PRESENT)), { recursive: true });
  writeFileSync(join(box.repo, PRESENT), '// fixture\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'docs: fixture');
  return { box, ctx: { info: { root: box.repo } } };
}

const check = file => ({ check: `npx jest --passWithNoTests ${file}` });

test('cli.io-item-bar-empty-check.refused: clause 1: with items.barRulesAtAdd on, a pass-with-no-tests check naming a test file absent from main is refused CHECK_PASSES_EMPTY naming the test -f fix [C7,#11779]', () => {
  const { ctx } = mainWithTest();
  assert.throws(() => requireNonEmptyCheck(ctx, check(ABSENT), true), error => {
    assert.equal(error.code, 'CHECK_PASSES_EMPTY');
    assert.match(error.next, new RegExp(`test -f ${ABSENT} && npx jest --passWithNoTests ${ABSENT}`, 'u'));
    return true;
  });
  assert.throws(() => requireNonEmptyCheck(ctx, { check: `npx vitest run --pass-with-no-tests ${ABSENT}` }, true), error => error.code === 'CHECK_PASSES_EMPTY');
});

test('cli.io-item-bar-empty-check.allowed: clause 2: a guarded check, a check without the flag, a test file on main, --accept-green and the setting off are all accepted [C7,#11779]', () => {
  const { ctx } = mainWithTest();
  requireNonEmptyCheck(ctx, { check: `test -f ${ABSENT} && npx jest --passWithNoTests ${ABSENT}` }, true);
  requireNonEmptyCheck(ctx, { check: `npx jest ${ABSENT}` }, true);
  requireNonEmptyCheck(ctx, check(PRESENT), true);
  requireNonEmptyCheck(ctx, check(ABSENT), true, 'the runner needs the flag');
  requireNonEmptyCheck(ctx, check(ABSENT), false);
});

test('cli.io-item-bar-empty-check.real-add: clause 3: the real add command refuses CHECK_PASSES_EMPTY with the setting on and files no item [C7,#11779]', async () => {
  const { box } = mainWithTest();
  const file = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  settings.items = { ...settings.items, barRulesAtAdd: true };
  writeFileSync(file, JSON.stringify(settings));
  const added = await fixtureAdd(box.runLocal, box.repo, 'web', 'Empty check', '--level', 'strong', '--specs', 'G1', '--brief', `Files:\n- ${PRESENT}\nTest: ${ABSENT}`, '--criterion', `1. ${ABSENT} proves the page [test]`, '--check', `npx jest --passWithNoTests ${ABSENT}`);
  assert.notEqual(added.code, 0);
  assert.match(`${added.out}${added.err}`, /CHECK_PASSES_EMPTY/u);
});
