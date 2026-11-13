/** @pullboard-test-input docs-tree */
/** @pullboard-world-pin reads docs/formats.md to prove it names the rate card form. */
/** A runner's rate card is stored in settings and validated, and the CLI sets it [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  SETTING_DESCRIPTIONS,
  loadMachineSettings,
} from '../../../../packages/config/index.js';
import { buildHelp } from '../../index.js';
import { main } from '../../tests/fixtures/native.js';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';
import {
  parseRunnerRate,
  runnerRate,
  validateRunnerRates,
} from '../../../../packages/config/src/logic/runner-rates.js';
import { runnerMinutes } from '../../../../packages/stats/src/logic/runners/minutes.js';

const CARD = { price: 1200, months: 36, watts: 85, kwhPrice: 0.14 };

test('a fixture item with checks on two runners reports each runner\'s minutes per check [C7]', () => {
  const receipts = [
    { id: 'a', kind: 'check', runner: 'studio.local', durationMs: 300_000 },
    { id: 'b', kind: 'check', runner: 'mini.local', durationMs: 90_000 },
    { id: 'c', kind: 'check', runner: 'studio.local', durationMs: 150_000 },
    { id: 'd', kind: 'check', runner: null, durationMs: 60_000 },
    { id: 'e', kind: 'land', runner: 'mini.local', durationMs: 999_000 },
  ];
  const report = runnerMinutes(receipts);
  assert.deepEqual(report.checks.map(({ id, runner, minutes }) => [id, runner, minutes]),
    [['a', 'studio.local', 5], ['b', 'mini.local', 1.5], ['c', 'studio.local', 2.5], ['d', 'local', 1]]);
});

test('the item\'s total minutes are reported per runner and overall [C7]', () => {
  const report = runnerMinutes([
    { id: 'a', kind: 'check', runner: 'studio.local', durationMs: 300_000 },
    { id: 'b', kind: 'check', runner: 'mini.local', durationMs: 90_000 },
    { id: 'c', kind: 'check', runner: 'studio.local', durationMs: 150_000 },
  ]);
  assert.deepEqual(report.perRunner, [
    { runner: 'studio.local', ms: 450_000, checks: 2, minutes: 7.5 },
    { runner: 'mini.local', ms: 90_000, checks: 1, minutes: 1.5 },
  ]);
  assert.equal(report.totalMinutes, 9);
  assert.deepEqual(runnerMinutes([]), { checks: [], perRunner: [], totalMs: 0, totalMinutes: 0 });
});

test('a full rate card is accepted and read back, and a bad field is refused [C7]', () => {
  assert.deepEqual(parseRunnerRate(CARD), CARD);
  const rates = validateRunnerRates({ 'studio.local': { ...CARD, extra: 'dropped' } });
  assert.deepEqual(runnerRate(rates, 'studio.local'), CARD);
  for (const [field, bad] of [['price', -1], ['months', 0], ['months', 1.5], ['watts', -5], ['kwhPrice', '0.14'], ['price', NaN], ['watts', undefined]]) {
    const card = { ...CARD, [field]: bad };
    assert.throws(() => validateRunnerRates({ 'studio.local': card }), error => error.code === 'BAD_RUNNER_RATES' && error.message.includes(field), `${field}=${bad} is refused`);
  }
  assert.throws(() => parseRunnerRate({ price: 1 }), /BAD_RUNNER_RATES|months/u, 'a partial card is refused');
  assert.throws(() => validateRunnerRates([CARD]), error => error.code === 'BAD_RUNNER_RATES');
  assert.match(SETTING_DESCRIPTIONS.runnerRates.description, /rate|price/u, 'the inventory describes the card');
});

test('a runner with no card reads back as not set [C7]', () => {
  assert.equal(runnerRate(validateRunnerRates(undefined), 'studio.local'), null);
  assert.equal(runnerRate({ other: CARD }, 'studio.local'), null);
  assert.equal(runnerRate(undefined, 'studio.local'), null);
});

/** Runs the real CLI in process against a private machine home and returns its exit code and output. */
async function settings(t, args) {
  const { root } = privateFixtureFiles('pullboard-rates-');
  const before = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = root;
  t.after(() => { if (before === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = before; });
  let stdout = '', stderr = '';
  const code = await main(['settings', ...args], { cwd: root, stdout: { isTTY: false, write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } } });
  return { code, stdout, stderr };
}

test('the CLI form stores a card that reads back, and a bad field stores nothing [C7]', async t => {
  const ok = await settings(t, ['runnerRates', 'studio.local', '1200', '36', '85', '0.14']);
  assert.equal(ok.code, 0, ok.stderr + ok.stdout);
  assert.deepEqual(runnerRate(loadMachineSettings().runnerRates, 'studio.local'), CARD);
  const bad = await settings(t, ['runnerRates', 'studio.local', '1200', '0', '85', '0.14']);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /BAD_RUNNER_RATES/u);
  assert.equal(runnerRate(loadMachineSettings().runnerRates, 'studio.local'), null, 'a refused card is not stored');
});

test('help and the formats doc name the rate card form [C7]', () => {
  const form = 'pullboard settings runnerRates <runner> <price> <months> <watts> <kwhPrice>';
  assert.ok(JSON.stringify(buildHelp()).includes(form), 'help names the form');
  assert.ok(readFileSync(fileURLToPath(new URL('../../../../docs/formats.md', import.meta.url)), 'utf8').includes(form), 'the formats doc names the form');
});
