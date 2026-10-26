/** Explicit CPU declarations stay distinct from ordinary private GUI fixtures [C7]. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cpuLoadOptionsIn } from '../src/module-imports.js';
import { testsNeedCpuRunner } from '../src/cpu-load-admission.js';
import { runFixtureChild } from './fixture-child.js';

/** Exercise both ordinary executable shapes and explicit positive/negative declarations. */
export async function fixtureContextCpuCase(t) {
  const sources = [
    ['forwarded context', "import test from 'node:test'; function fixture(context) { context.after(() => {}); } test('ordinary', async t => { fixture(t); });"],
    ['regular expression method', "import test from 'node:test'; test('ordinary', () => { const row = { text: 'strong' }; /strong/.test(row.text); });"],
    ['local callback without options', "import test from 'node:test'; const label = 'ordinary'; const body = async context => { context.after(() => {}); }; test(label, body);"],
  ];
  for (const [name, source] of sources) await t.test(name, () => {
    assert.equal(cpuLoadOptionsIn([source])[0], false, 'ordinary executable code is not an explicit CPU-load option');
  });
  await t.test('an actual imported function is a callback without options', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pullboard-callable-import-'));
    try {
      writeFileSync(join(directory, 'body.js'), 'export function body(context) { context.after(() => {}); }\n');
      writeFileSync(join(directory, 'ordinary.test.js'), "import { test as register } from 'node:test'; import { body } from './body.js'; register('ordinary', body);\n");
      assert.equal(testsNeedCpuRunner(directory, ['ordinary.test.js']), false,
        'the bounded real module graph proves an exported function, not opaque options');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  assert.equal(cpuLoadOptionsIn(["import test from 'node:test'; import options from './unresolved.js'; test('pending', options);"])[0], true,
    'an unresolved import may be options and stays conservative');
  assert.equal(cpuLoadOptionsIn(["import test from 'node:test'; const options = { cpuLoad: true }; test('pending', options);"])[0], true,
    'a two-argument named TODO registration may still supply options');
  assert.equal(cpuLoadOptionsIn(["import test from 'node:test'; function body() {} body = { cpuLoad: true }; test('pending', body);"])[0], true,
    'a reassigned function binding is not proven callable');
  assert.equal(cpuLoadOptionsIn(["import test from 'node:test'; function body() {} function register(body) { test('pending', body); }"])[0], true,
    'a shadowed callback name may be options and stays conservative');
  assert.equal(cpuLoadOptionsIn(["import test from 'node:test'; test('busy', { cpuLoad: true }, () => {});"])[0], true,
    'an explicit CPU-load declaration remains classified');
  assert.equal(cpuLoadOptionsIn(["import test from 'node:test'; test('ordinary', { cpuLoad: false }, () => {});"])[0], false,
    'an explicit false option does not generate CPU load');
  assert.equal(cpuLoadOptionsIn(["import test from 'node:test'; const data = { cpuLoad: true }; test('ordinary', () => data);"])[0], false,
    'an unrelated data object is not a test registration option');
  assert.equal(cpuLoadOptionsIn(["import { test as check } from 'node:test'; check('busy', { 'cpuLoad': true }, () => {});"])[0], true,
    'a renamed test and quoted explicit option still declare CPU load');
  assert.equal(cpuLoadOptionsIn(["import test from 'node:test'; const name = 'busy'; test(name, { cpuLoad: true }, () => {});"])[0], true,
    'a variable test name does not move the options argument');
  assert.equal(cpuLoadOptionsIn(["import test from 'node:test'; test('busy', { cpuLoad: true /* measured load */ }, () => {});"])[0], true,
    'an inline comment does not hide an explicit true option');
  assert.equal(cpuLoadOptionsIn(["import test from 'node:test'; function body() {} test('busy', { cpuLoad: true }, body);"])[0], true,
    'a named callback does not hide a real options argument');
  assert.equal(cpuLoadOptionsIn(["import test from 'node:test'; function body() {} test({ cpuLoad: true }, body);"])[0], true,
    'the options-first overload retains its explicit declaration');
}

/** Observe policy in a private machine home without connecting to or configuring a real runner. */
export function guiCpuPolicyCase() {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-cpu-gui-policy-'));
  try {
    const machineHome = join(directory, 'machine');
    mkdirSync(machineHome);
    writeFileSync(join(machineHome, 'settings.json'), JSON.stringify({ gateSlots: 1, browserSlots: 1,
      runners: [{ host: 'private-non-gui-fixture', slots: 1, browser: 1, gui: false }] }));
    writeFileSync(join(directory, 'gui.test.js'), "/** @pullboard-test-gui */\nimport test from 'node:test'; function fixture(context) { context.after(() => {}); } test('GUI', t => { fixture(t); });\n");
    writeFileSync(join(directory, 'cpu.test.js'), "import test from 'node:test'; test('busy', { cpuLoad: true }, () => {});\n");
    const classify = pathToFileURL(resolve(import.meta.dirname, '../src/cpu-load-admission.js')).href;
    const gui = pathToFileURL(resolve(import.meta.dirname, '../src/gui-admission.js')).href;
    const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', `
      import { cpuRunnerRequired } from ${JSON.stringify(classify)};
      import { testsNeedGui } from ${JSON.stringify(gui)};
      const root = ${JSON.stringify(directory)};
      console.log(JSON.stringify({ gui: testsNeedGui(root, ['gui.test.js']),
        guiRunnerOnly: cpuRunnerRequired(root, ['gui.test.js']),
        explicitCpuRunnerOnly: cpuRunnerRequired(root, ['cpu.test.js']) }));
    `], { cwd: directory, env: { ...process.env, PULLBOARD_MACHINE_HOME: machineHome }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.context);
    const observed = JSON.parse(result.stdout);
    assert.equal(observed.gui, true, 'the public classifier preserves the GUI requirement');
    assert.equal(observed.guiRunnerOnly, false, 'ordinary GUI work can use its eligible local slot');
    assert.equal(observed.explicitCpuRunnerOnly, true, 'explicit CPU work still requires the registered runner');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
