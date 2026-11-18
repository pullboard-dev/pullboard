/** With gate.knownMainStatic on, a static finding main also has never refuses an item; the rest still does [C7,#10450]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { executionServices } from '../../fixtures/execution.js';
import { runStaticChecks } from '../../../src/io/static/check.js';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { fixtureCommitAll } from '../../fixtures/testkit.js';
import { fixtureMachineSettings } from '../../fixtures/testkit.js';

const MAIN_ROW = 'packages/a/x.js:3: runs a git fetch outside the one entry point';
const ITEM_ROW = 'packages/b/y.js:9: tests read a cell by path';

/** A fixture repository whose static command prints `rows` and exits red, under a machine home holding `settings`. */
function redRepo(t, rows, settings) {
  const { root } = privateFixtureFiles('pullboard-known-main-');
  writeFileSync(join(root, 'check.sh'), `${rows.map(row => `echo 'STATIC_RED ${row}'`).join('\n')}\nexit 1\n`);
  fixtureCommitAll(root);
  const home = join(root, '..', `${root.split('/').at(-1)}-machine`);
  mkdirSync(home, { recursive: true });
  fixtureMachineSettings(home, settings);
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
  return root;
}

const mainFindings = async () => [{ rule: 'runs a git fetch outside the one entry point', file: 'packages/a/x.js' }];

test('gate.io-static-known-main.every-finding-also-red-on-main: clause 1: with gate.knownMainStatic on and every finding also red on main, runStaticChecks returns them as knownMain and throws no GATE_RED [C7,#10450]', async t => {
  const root = redRepo(t, [MAIN_ROW], { gate: { knownMainStatic: true } });
  const result = await runStaticChecks(root, { staticChecks: 'sh check.sh' }, { executionServices, mainFindings });
  assert.deepEqual(result.knownMain, [{ rule: 'runs a git fetch outside the one entry point', file: 'packages/a/x.js' }]);
});

test('gate.io-static-known-main.finding-red-only-on-the-item: clause 2: a finding red only on the item still throws GATE_RED naming just that finding, and with the setting off the throw is unchanged [C7,#10450]', async t => {
  const root = redRepo(t, [MAIN_ROW, ITEM_ROW], { gate: { knownMainStatic: true } });
  await assert.rejects(runStaticChecks(root, { staticChecks: 'sh check.sh' }, { executionServices, mainFindings }), error => {
    assert.equal(error.code, 'GATE_RED');
    assert.match(error.message, /packages\/b\/y\.js:9/u);
    assert.doesNotMatch(error.message, /packages\/a\/x\.js/u, 'main\'s finding is not named');
    return true;
  });
  const off = redRepo(t, [MAIN_ROW], {});
  await assert.rejects(runStaticChecks(off, { staticChecks: 'sh check.sh' }, { executionServices, mainFindings }), error => {
    assert.equal(error.code, 'GATE_RED');
    assert.match(error.message, /packages\/a\/x\.js:3/u, 'the setting off names every finding');
    return true;
  });
});
