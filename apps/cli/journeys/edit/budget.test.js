/** Authored build scope is cut before claim, and capacity measures real build intervals against it [N2,B3]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { configFromSource } from '../../../../packages/config/index.js';
import { parseExpectedBuildMinutes } from '../../../../packages/items/index.js';
import { buildCalibration } from '../../../../packages/stats/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

/** Require native success before parsing a command's public JSON contract. */
function json(result) {
  assert.equal(result.code, 0, result.out + result.err);
  return JSON.parse(result.out);
}

test('over-budget scope refuses claim, cut children build, and capacity compares the actual native interval [N2,B3]', { timeout: 180_000 }, t => { // budget: hang ceiling for private Git/SQLite add, claim, submit and capacity commands.
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.submit = { handoff: false };
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'test: private foreground submit [G1]');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  /** Author a real frozen check whose file the build must create; children retain their parent link. */
  function add(title, expected, parent) {
    return json(fixtureAdd(box.run, box.repo, 'web', title, '--criterion', 'The result file exists.', '--expected-minutes', String(expected),
      '--check', 'test -f web/result.txt', '--wait', ...(parent ? ['--parent', String(parent)] : []), '--json')).item.item_id;
  }
  const parent = add('Cut this large build', 60);
  assert.equal(json(box.run(box.repo, 'edit', String(parent), '--expected-minutes', '50', '--json')).item.item_expected_build_minutes, 50);
  const refused = box.run(box.web, 'claim', String(parent), '--json');
  assert.notEqual(refused.code, 0);
  assert.match(refused.out + refused.err, /ITEM_BUILD_BUDGET/u);
  assert.match(refused.out + refused.err, /30-minute.*budget/u);
  assert.match(refused.out + refused.err, /parent and children/u);
  assert.equal(json(box.run(box.repo, 'show', String(parent), '--json')).item_status, 'open');
  const child = add('Build one bounded child', 20, parent);
  json(box.run(box.web, 'claim', String(child), '--json'));
  assert.equal(json(box.run(box.repo, 'show', String(child), '--json')).item_expected_build_minutes, 20);
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web/result.txt'), 'bounded child\n');
  box.git(box.web, 'add', 'web/result.txt');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): bounded child [G1]');
  json(box.run(box.web, 'submit', String(child), '--no-next', '--json'));
  const capacity = json(box.run(box.repo, 'capacity', '--json')).report;
  const measured = capacity.builds.items.find(row => row.item === child);
  assert.equal(capacity.builds.budgetMinutes, 30);
  assert.equal(measured.expectedMinutes, 20);
  assert.ok(measured.actualMinutes >= 0);
  assert.equal(measured.ratio, measured.actualMinutes / measured.expectedMinutes);
  assert.equal(capacity.builds.calibration.samples, 1);
  assert.match(box.run(box.repo, 'capacity').out, /expected 20\.000 min; actual/u);
  config.itemBuildBudgetMinutes = 10;
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'test: accepted ten minute build budget [G1]');
  box.git(box.web, 'merge', '-q', 'main');
  const tooLarge = add('Still needs another cut', 11, parent);
  const limited = box.run(box.web, 'claim', String(tooLarge), '--json');
  assert.match(limited.out + limited.err, /10-minute.*budget/u);
  const bounded = add('Fits the accepted budget', 10, parent);
  json(box.run(box.web, 'claim', String(bounded), '--json'));
  json(box.run(box.web, 'release', String(bounded), '--reason', 'OTHER', '--note', 'The private claimability check completed.', '--no-next', '--json'));
  assert.equal(json(box.run(box.repo, 'edit', String(parent), '--expected-minutes', 'unknown', '--json')).item.item_expected_build_minutes, undefined);
});

test('build estimates and board budgets reject invalid numbers and keep unknown duration explicit [N2,B3]', () => {
  assert.equal(configFromSource('{}').itemBuildBudgetMinutes, 30);
  assert.equal(configFromSource('{"itemBuildBudgetMinutes":12.5}').itemBuildBudgetMinutes, 12.5);
  for (const value of [0, -1, null, '30']) assert.throws(() => configFromSource(JSON.stringify({ itemBuildBudgetMinutes: value })), { code: 'BAD_CONFIG' });
  for (const value of ['', '0', '-1', 'Infinity', 'not time']) assert.throws(() => parseExpectedBuildMinutes(value), { code: 'BAD_BUILD_ESTIMATE' });
  assert.equal(parseExpectedBuildMinutes('unknown'), null);
  assert.equal(parseExpectedBuildMinutes('12.5'), 12.5);
  const history = [
    { event_id: 1, item_id: 1, event_kind: 'claim', event_at: '2026-11-01T00:00:00Z', event_detail: '{"expectedBuildMinutes":10}' },
    { event_id: 2, item_id: 1, event_kind: 'renew', event_at: '2026-11-01T00:09:00Z', event_detail: '{}' },
    { event_id: 3, item_id: 1, event_kind: 'submit', event_at: '2026-11-01T00:20:00Z', event_detail: '{}' },
    { event_id: 4, item_id: 2, event_kind: 'submit', event_at: '2026-11-01T00:20:00Z', event_detail: '{}' },
  ];
  const report = buildCalibration(history, [{ item_id: 1, item_title: 'renewed', item_expected_build_minutes: 5 }, { item_id: 2, item_title: 'historical' }]);
  assert.deepEqual(report.items.map(({ expectedMinutes, actualMinutes, ratio }) => ({ expectedMinutes, actualMinutes, ratio })),
    [{ expectedMinutes: 10, actualMinutes: 20, ratio: 2 }, { expectedMinutes: null, actualMinutes: null, ratio: null }]);
});

const EVIDENCE_MODEL = 'Inspection evidence fixture';

/** Add and edit admission through the real CLI: a clause without an evidence kind is refused before the check starts [C7]. */
test('real CLI refuses add/edit before starting the check and exposes reasoning warnings [C7]', t => {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const isolated = e2e.sandbox();
  isolated.env.PULLBOARD_MODEL = EVIDENCE_MODEL;
  const box = e2e.project('true', isolated);
  const marker = join(box.repo, 'should-not-execute');
  const check = `node -e 'require("node:fs").writeFileSync(${JSON.stringify(marker)},"ran")'`;
  const bad = fixtureAdd(box.run, box.repo, 'web', 'Invalid evidence', '--criterion', '1. returns zero', '--check', check,
    '--route', 'mid', '--brief', 'Files: web/page.html\nTest: refusal before check');
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /CLAUSE_EVIDENCE_REQUIRED/u);
  assert.equal(existsSync(marker), false);
  const added = fixtureAdd(box.run, box.repo, 'web', 'Design evidence', '--criterion', '1. explain design [reasoning]', '--check', 'true',
    '--route', 'mid', '--brief', 'Files: web/page.html\nTest: native evidence warning', '--json');
  assert.equal(added.code, 0, added.err);
  const result = JSON.parse(added.out);
  assert.equal(result.warnings[0].code, 'CLAUSE_REASONING_WEAK');
  const edited = box.run(box.repo, 'edit', String(result.item.item_id), '--criterion', '1. no kind', '--check', check, '--reason', 'invalid correction');
  assert.notEqual(edited.code, 0);
  assert.match(edited.err, /CLAUSE_EVIDENCE_REQUIRED/u);
  assert.equal(existsSync(marker), false);
});
