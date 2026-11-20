/** @pullboard-test-input source-cell apps/cli */
/** With gate.junitReport set, submit ticks the [test] clauses a JUnit report proves; unset, it selects gate files as before (#9727) [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { fixtureSettledMachine } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { fileFixtureItem } from '../../../../../packages/gate/tests/fixtures/testkit.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);
const CRITERION = 'The math works:\n1) adds two numbers [test]\n2) halves a number [test]';
const REPORT = cases => `<?xml version="1.0"?>\n<testsuites><testsuite name="pytest" tests="${cases.length}">\n${cases.map(([name, failed]) => `<testcase classname="tests.test_math" name="${name}">${failed ? '<failure message="assert 1 == 2"/>' : ''}</testcase>`).join('\n')}\n</testsuite></testsuites>\n`;

/** Add, claim and commit one item with a [test] clause pair, leave the report beside it, and submit; returns the submit result and the thread. */
async function submitWith(cases, { setting }) {
  const box = helpers.project('true');
  if (setting) fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, { gate: { junitReport: 'junit.xml' } });
  const item = await fileFixtureItem(box, box.repo, { lane: 'web', title: 'JUnit fixture', criterion: CRITERION, check: null, run: box.runIn });
  const id = String(item.item_id);
  assert.equal((await box.runIn(box.web, 'claim', id)).code, 0);
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web', 'fixture.js'), 'export const complete = true;\n');
  writeFileSync(join(box.web, '.gitignore'), 'junit.xml\n');
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): complete the fixture [G1]');
  writeFileSync(join(box.web, 'junit.xml'), REPORT(cases));
  const submitted = await box.runIn(box.web, 'submit', id, '--no-next');
  const shown = JSON.parse((await box.runIn(box.web, 'show', id, '--json', '--no-next')).out);
  return { submitted, thread: (shown.thread ?? []).map(row => String(row.text ?? '')) };
}

test('cli.journeys-submit-junit-clauses.with-gate-junitreport-set-submit-on: clause 1: with gate.junitReport set, submit on a project whose test command wrote JUnit XML ticks the [test] clauses the report names [C7,#9727]', { timeout: 240_000 }, async () => {
  const { submitted, thread } = await submitWith([['clause 1: adds two numbers'], ['clause 2: halves a number']], { setting: true });
  assert.equal(submitted.code, 0, `${submitted.out}\n${submitted.err}`);
  assert.ok(thread.some(text => /^clause 1 \[test\]: JUnit report junit\.xml at [0-9a-f]{12}/u.test(text)), thread.join('\n'));
  assert.ok(thread.some(text => /^clause 2 \[test\]: JUnit report junit\.xml/u.test(text)));
});

test('cli.journeys-submit-junit-clauses.a-failing-case-in-the-report: clause 2: a failing case in the report leaves its clause unticked and names the case [C7,#9727]', { timeout: 240_000 }, async () => {
  const { submitted, thread } = await submitWith([['clause 1: adds two numbers'], ['clause 2: halves a number', true]], { setting: true });
  assert.notEqual(submitted.code, 0);
  assert.match(submitted.out + submitted.err, /case "clause 2: halves a number" failed/u);
  assert.ok(thread.some(text => /^clause 1 \[test\]: JUnit report/u.test(text)));
  assert.equal(thread.some(text => /^clause 2 \[test\]: JUnit report/u.test(text)), false);
});

test('cli.journeys-submit-junit-clauses.with-gate-junitreport-unset-submit-reads: clause 3: with gate.junitReport unset, submit reads no report and records no JUnit tick [C7,#9727]', { timeout: 240_000 }, async () => {
  const { submitted, thread } = await submitWith([['clause 1: adds two numbers'], ['clause 2: halves a number']], { setting: false });
  assert.notEqual(submitted.code, 0);
  assert.match(submitted.out + submitted.err, /CLAUSE_UNTICKED|no evidence/u);
  assert.equal(thread.some(text => /JUnit report/u.test(text)), false);
});
