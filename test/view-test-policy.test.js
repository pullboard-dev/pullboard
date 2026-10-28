/** @pullboard-test-input source-tree */
/** @pullboard-test-input test-tree */
/**
 * The view-pure source adapter and its gate hook [N26,C7]: it compiles source, never runs a browser,
 * fails closed on the roots #1419 declares and only reports the rest.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { ENFORCED_FILE } from '../bin/checks/view-pure.js';
import { enforcedRoots } from '../bin/checks/view-pure.js';
import { viewPureGate } from '../bin/checks/view-pure.js';
import { viewPureReport } from '../bin/checks/view-pure.js';

const REPO = resolve(import.meta.dirname, '..');
const GOOD = 'test/cockpit/good.test.js', BAD = 'test/cockpit/bad.test.js', RENDER = 'src/view/example.js';
const ROLES = {
  [GOOD]: { kind: 'logic', reason: 'Seeded data through the actual renderer' },
  [BAD]: { kind: 'logic', reason: 'Seeded data through the actual renderer' },
};
const COVERAGE = [{ module: RENDER, names: ['render'], tests: [GOOD] }];

/** A private source tree: both roots import the renderer, and BAD also reaches an impure helper. */
function tree(t, enforcedList) {
  const root = mkdtempSync(join(tmpdir(), 'view-pure-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  /** Write one private source file. */
  const put = (path, text) => { const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
  const test = "import { render } from '../../src/view/example.js'; render({ title: 'hi' });";
  put(GOOD, test);
  put(BAD, test + " import { run } from '../helper.js'; run();");
  put(RENDER, 'export function render(input) { return input.title; }');
  put('test/helper.js', "import { spawnSync } from 'node:child_process'; import { readFileSync } from 'node:fs'; export const run = () => spawnSync('chrome', [readFileSync('x')]);");
  if (enforcedList) put(ENFORCED_FILE, JSON.stringify({ roots: enforcedList }));
  return { root, put };
}

test('a view logic test reaching spawnSync and node:fs through a helper names root, helper and builtin [N26,C7]', t => {
  const { root } = tree(t);
  const findings = viewPureReport(root, { roles: ROLES, coverage: COVERAGE });
  assert.ok(findings.every(finding => finding.path === BAD), 'only the impure root is named');
  const text = findings.map(finding => finding.text).join('\n');
  assert.match(text, /test\/helper\.js:\d+: logic reaches boundary-capable builtin node:child_process/u);
  assert.match(text, /test\/helper\.js:\d+: logic reaches boundary-capable builtin node:fs/u);
  assert.match(text, /spawnSync/u);
});

test('the gate fails an enforced impure root and only reports an unenforced one [N26,C7]', t => {
  const enforcedGood = tree(t, [GOOD]);
  const loose = viewPureGate(enforcedGood.root, { roles: { ...ROLES, [BAD]: { kind: 'adapter', reason: 'Native IO contract has not been migrated' } }, coverage: COVERAGE });
  assert.deepEqual(loose.failures, [], 'a finding outside the declared roots never fails');
  assert.deepEqual(loose.reported, [], 'adapter reach does not pretend to be a pure root');
  const unpromoted = viewPureGate(enforcedGood.root, { roles: ROLES, coverage: COVERAGE });
  assert.ok(unpromoted.failures.some(finding => finding.path === BAD && finding.text.includes('must be promoted')));
  assert.ok(unpromoted.reported.length > 0 && unpromoted.reported.every(finding => finding.path === BAD));
  const enforcedBad = tree(t, [GOOD, BAD]);
  const strict = viewPureGate(enforcedBad.root, { roles: ROLES, coverage: COVERAGE });
  assert.ok(strict.failures.length > 0 && strict.failures.every(finding => finding.path === BAD));
  assert.deepEqual(strict.reported, [], 'promotion moves every finding from reported to failing');
  assert.equal(strict.failures.length, unpromoted.reported.length, 'the impurity count is conserved across promotion');
});

test('fixing the helper lets the promoted root pass and a regression fails it again [N26,C7]', t => {
  const { root, put } = tree(t, [GOOD, BAD]);
  put('test/helper.js', 'export const run = () => 1;');
  assert.deepEqual(viewPureGate(root, { roles: ROLES, coverage: COVERAGE }).failures, []);
  put('test/helper.js', "import { writeFileSync } from 'node:fs'; export const run = () => writeFileSync('x', '');");
  assert.ok(viewPureGate(root, { roles: ROLES, coverage: COVERAGE }).failures.some(finding => finding.text.includes('node:fs')));
});

test('the gate fails closed when the list is missing, empty or names an unusable root [N26,C7]', t => {
  const missing = tree(t);
  assert.match(enforcedRoots(missing.root).problems[0].text, /unreadable/u);
  assert.ok(viewPureGate(missing.root, { roles: ROLES, coverage: COVERAGE }).failures.length > 0, 'no list is a failure, never a pass');
  const empty = tree(t, []);
  assert.match(enforcedRoots(empty.root).problems[0].text, /empty or not an array/u);
  const absent = tree(t, ['test/cockpit/gone.test.js']);
  assert.ok(viewPureGate(absent.root, { roles: ROLES, coverage: COVERAGE }).failures.some(finding => finding.text.includes('not a test/cockpit test file')));
  const journey = tree(t, [GOOD]);
  const relabeled = { ...ROLES, [GOOD]: { kind: 'journey', reason: 'Relabeled to dodge the lint' } };
  assert.ok(viewPureGate(journey.root, { roles: relabeled, coverage: COVERAGE }).failures.some(finding => finding.text.includes('no logic role')),
    'relabeling an enforced root fails instead of silencing it');
});

test('an exported HTML renderer without a coverage mapping cannot hide in advisory debt [N26,C7]', t => {
  const { root, put } = tree(t, [GOOD]);
  put('src/view/uncovered-render.js', 'export function uncoveredHtml(input) { return input.title; }');
  const result = viewPureGate(root, { roles: { [GOOD]: ROLES[GOOD], [BAD]: { kind: 'adapter', reason: 'Native IO contract' } }, coverage: COVERAGE });
  assert.ok(result.failures.some(finding => finding.path === 'src/view/uncovered-render.js' && finding.text.includes('uncoveredHtml')));
  assert.deepEqual(result.reported, []);
});

test('an unparseable or computed import in the closure is an unknown-reach finding, and source is never executed [N26,C7]', t => {
  const { root, put } = tree(t, [GOOD]);
  const roles = { ...ROLES, [BAD]: { kind: 'adapter', reason: 'Unrelated native IO contract' } };
  put(RENDER, "export function render(input) { throw new Error('must not run'); }");
  assert.deepEqual(viewPureGate(root, { roles, coverage: COVERAGE }).failures, []);
  put(RENDER, 'export function render(input) { return import(input.path); }');
  assert.ok(viewPureGate(root, { roles, coverage: COVERAGE }).failures.some(finding => /nonliteral|unresolved|unknown reach/u.test(finding.text)));
  put(RENDER, 'export function render( {');
  assert.ok(viewPureGate(root, { roles, coverage: COVERAGE }).failures.length > 0, 'source that does not compile cannot pass as pure');
});

test('this checkout passes the gate: every declared root is clean and the rest only reports [N26,C7]', () => {
  const { failures, enforced } = viewPureGate(REPO);
  assert.ok(enforced.length > 0, 'the declared list is not empty');
  assert.deepEqual(failures.map(finding => finding.path + ':' + finding.text), []);
});
