/** Declared load is placed by the real runner road, never by a forged host flag [C7]. */
/** @pullboard-test-input source-tree */
import assert from 'node:assert/strict';
import { join, relative, sep } from 'node:path';
import { after, test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { cpuLoadFixture } from './cpu-load-test-fixture.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('a declared CPU-load test runs only on a runner when one is registered [C7]', async () => {
  const box = cpuLoadFixture(e2e);
  const remote = await box.runGate();
  assert.equal(remote.result.status, 0, remote.result.context);
  assert.equal(box.requestsMade().length, 1, 'the declared CPU-load test dispatches to the registered runner even when local-first has a free slot');
  assert.ok(remote.executor?.liveLease, 'the test body reports an actual private resource holder');
  assert.equal(remote.executor.runnerExecution, true, 'worker execution is bound to the genuine inherited lease');
  assert.notEqual(remote.executor.cwd, box.repo, 'the declared test body never starts in the coordinator checkout');
  const withinRunner = relative(join(box.remoteHome, '.pullboard-runner', 'jobs'), remote.executor.cwd);
  assert.ok(withinRunner && withinRunner !== '..' && !withinRunner.startsWith(`..${sep}`));
  assert.equal(remote.executor.gatePool, join(box.remoteMachineHome, 'resources.sqlite'));
  box.command('runner', 'remove', 'fixture-host');
  box.commitProbeChange();
  const local = await box.runGate();
  assert.equal(local.result.status, 0, local.result.context);
  assert.equal(box.requestsMade().length, 1, 'no unregistered executor is used for the fallback');
  assert.equal(local.executor?.cwd, box.repo);
  assert.match(local.log + local.result.stderr, /CPU.load[\s\S]*no (?:registered )?runners|no runners are registered/iu,
    'the no-runner local fallback explains why it is local');
});


test('a false CPU-load option and textual examples keep ordinary local-first admission [C7]', async () => {
  const box = cpuLoadFixture(e2e, { declaration: '{ cpuLoad: false }' });
  const local = await box.runGate();
  assert.equal(local.result.status, 0, local.result.context);
  assert.equal(box.requestsMade().length, 0, 'comments, string examples and a false option do not force runner execution');
  assert.equal(local.executor?.cwd, box.repo);
  assert.equal(local.executor?.liveLease, true);
  assert.equal(local.executor?.runnerExecution, false);
});

test('a computed true CPU-load option is not mistaken for a literal false option [C7]', async () => {
  const box = cpuLoadFixture(e2e, { declaration: '{ cpuLoad: false || true }' });
  const remote = await box.runGate();
  assert.equal(remote.result.status, 0, remote.result.context);
  assert.equal(box.requestsMade().length, 1);
  assert.equal(remote.executor?.runnerExecution, true);
  assert.notEqual(remote.executor?.cwd, box.repo);
});

test('an inline comment in a CPU-load option keeps the test on its registered runner [C7]', async () => {
  const box = cpuLoadFixture(e2e, { declaration: '{ cpuLoad /* explanation */ : true }' });
  const remote = await box.runGate();
  assert.equal(remote.result.status, 0, remote.result.context);
  assert.equal(box.requestsMade().length, 1, 'valid inline comments do not hide the CPU-load declaration');
  assert.equal(remote.executor?.runnerExecution, true);
  assert.notEqual(remote.executor?.cwd, box.repo);
});

test('a shorthand CPU-load option keeps the test on its registered runner [C7]', async () => {
  const box = cpuLoadFixture(e2e, { declaration: '(() => { const cpuLoad = true; return { cpuLoad }; })()' });
  const remote = await box.runGate();
  assert.equal(remote.result.status, 0, remote.result.context);
  assert.equal(box.requestsMade().length, 1, 'a valid shorthand CPU-load option does not run on the coordinator');
  assert.equal(remote.executor?.runnerExecution, true);
  assert.notEqual(remote.executor?.cwd, box.repo);
});

test('a quoted CPU-load key with a Unicode escape uses its registered runner [C7]', async () => {
  const box = cpuLoadFixture(e2e, { declaration: String.raw`{ "cpu\u004coad": true }` });
  const remote = await box.runGate();
  assert.equal(remote.result.status, 0, remote.result.context);
  assert.equal(box.requestsMade().length, 1, 'a valid escaped key declares the same CPU-load option');
  assert.equal(remote.executor?.runnerExecution, true);
  assert.notEqual(remote.executor?.cwd, box.repo);
});

test('a doubly escaped textual key stays ordinary local-first work [C7]', async () => {
  const box = cpuLoadFixture(e2e, { declaration: String.raw`{ "cpu\\u004coad": true }` });
  const local = await box.runGate();
  assert.equal(local.result.status, 0, local.result.context);
  assert.equal(box.requestsMade().length, 0, 'a literal backslash in a different key is not decoded twice into a CPU declaration');
  assert.equal(local.executor?.cwd, box.repo);
  assert.equal(local.executor?.liveLease, true);
  assert.equal(local.executor?.runnerExecution, false);
});


test('a constant computed template CPU-load key uses its registered runner [C7]', async () => {
  const box = cpuLoadFixture(e2e, { declaration: '{ [`cpuLoad`]: true }' });
  const remote = await box.runGate();
  assert.equal(remote.result.status, 0, remote.result.context);
  assert.equal(box.requestsMade().length, 1, 'a constant computed template key declares the same CPU-load option');
  assert.equal(remote.executor?.runnerExecution, true);
  assert.notEqual(remote.executor?.cwd, box.repo);
});

test('CPU-load syntax inside literal template text stays ordinary local-first work [C7]', async () => {
  const box = cpuLoadFixture(e2e, { declaration: '{ example: `cpuLoad: true` }' });
  const local = await box.runGate();
  assert.equal(local.result.status, 0, local.result.context);
  assert.equal(box.requestsMade().length, 0, 'template text is an example, not an executable CPU-load option');
  assert.equal(local.executor?.cwd, box.repo);
  assert.equal(local.executor?.liveLease, true);
  assert.equal(local.executor?.runnerExecution, false);
});


// These conservative-placement controls were added after the coordinator sharpened the contract.
for (const [kind, declaration, binding] of [
  ['computed property', '{ [["cpu", "Load"].join("")]: true }', 'test'],
  ['spread property', '{ ...Object.fromEntries([[ ["cpu", "Load"].join(""), true ]]) }', 'test'],
  ['opaque options and an imported alias', 'Object.fromEntries([[ ["cpu", "Load"].join(""), true ]])', 'register'],
  ['invoked option factory', '(() => Object.fromEntries([[ ["cpu", "Load"].join(""), true ]]))()', 'test'],
]) test(`unreadable ${kind} options conservatively use a registered runner [C7]`, async () => {
  const box = cpuLoadFixture(e2e, { declaration, binding });
  const remote = await box.runGate();
  assert.equal(remote.result.status, 0, remote.result.context);
  assert.equal(box.requestsMade().length, 1, 'unresolved executable options cannot start on the coordinator');
  assert.equal(remote.executor?.runnerExecution, true);
  assert.notEqual(remote.executor?.cwd, box.repo);
});


for (const [kind, declaration] of [
  ['escaped prototype', String.raw`{ "__pr\u006fto__": Object.fromEntries([[ ["cpu", "Load"].join(""), true ]]) }`],
  ['computed accessor', '{ get ["cpuLoad"]() { return true; } }'],
]) test(`unreadable ${kind} options cannot hide a CPU-load declaration [C7]`, async () => {
  const box = cpuLoadFixture(e2e, { declaration });
  const remote = await box.runGate();
  assert.equal(remote.result.status, 0, remote.result.context);
  assert.equal(box.requestsMade().length, 1, 'unreadable prototype or accessor options require the registered runner');
  assert.equal(remote.executor?.runnerExecution, true);
  assert.notEqual(remote.executor?.cwd, box.repo);
});


for (const [kind, subtest] of [
  ['quoted', 't["test"]'],
  ['template', 't[`test`]'],
  ['computed', 't[["te", "st"].join("")]'],
]) test(`a ${kind} subtest call with unreadable CPU options uses its runner [C7]`, async () => {
  const box = cpuLoadFixture(e2e, { subtest,
    declaration: 'Object.fromEntries([[ ["cpu", "Load"].join(""), true ]])' });
  const remote = await box.runGate();
  assert.equal(remote.result.status, 0, remote.result.context);
  assert.equal(box.requestsMade().length, 1, 'valid computed subtest calls cannot hide unreadable CPU options');
  assert.equal(remote.executor?.runnerExecution, true);
  assert.notEqual(remote.executor?.cwd, box.repo);
});


// AFTER-only negative: a readable direct subtest and its ordinary lifecycle hook are not opaque load.
test('a readable false direct subtest and context lifecycle hook stay local [C7]', async () => {
  const box = cpuLoadFixture(e2e, { subtest: 't.test', declaration: '{ cpuLoad: false }' });
  const local = await box.runGate();
  assert.equal(local.result.status, 0, local.result.context);
  assert.equal(box.requestsMade().length, 0);
  assert.equal(local.executor?.cwd, box.repo);
  assert.equal(local.executor?.liveLease, true);
  assert.equal(local.executor?.runnerExecution, false);
});


// AFTER-only: unresolved CommonJS registration is conservatively placed without executing it.
test('opaque CommonJS registration uses its genuine runner and browser lease [C7]', async () => {
  const box = cpuLoadFixture(e2e, { commonjs: true, binding: 'register',
    declaration: 'Object.fromEntries([[ ["cpu", "Load"].join(""), true ]])' });
  const remote = await box.runGate();
  assert.equal(remote.result.status, 0, remote.result.context);
  assert.equal(box.requestsMade().length, 1);
  assert.equal(remote.executor?.runnerExecution, true);
  assert.equal(remote.executor?.browserLease, true, 'the conservative CommonJS browser requirement has a real private holder');
  assert.notEqual(remote.executor?.cwd, box.repo);
});


// AFTER-only: dynamic module loading cannot hide a registration alias with executable options.
test('dynamic node:test registration with opaque options uses its runner [C7]', async () => {
  const box = cpuLoadFixture(e2e, { dynamicImport: true, binding: 'register',
    declaration: 'Object.fromEntries([[ ["cpu", "Load"].join(""), true ]])' });
  const remote = await box.runGate();
  assert.equal(remote.result.status, 0, remote.result.context);
  assert.equal(box.requestsMade().length, 1);
  assert.equal(remote.executor?.runnerExecution, true);
  assert.notEqual(remote.executor?.cwd, box.repo);
});


// Test-first binding controls: imported opaque options must not evade registration discovery.
for (const [kind, importBinding, moduleSpecifier] of [
  ['commented', 'test /* registration */ as check', 'node:test'],
  ['quoted', "'test' as check", 'node:test'],
  ['escaped module', 'test as check', String.raw`node:t\u0065st`],
]) test(`a ${kind} test import with opaque imported options uses its runner [C7]`, async () => {
  const box = cpuLoadFixture(e2e, { binding: 'check', importBinding, moduleSpecifier,
    importedOptions: true, declaration: 'options' });
  const remote = await box.runGate();
  assert.equal(remote.result.status, 0, remote.result.context);
  assert.equal(box.requestsMade().length, 1, 'valid import binding syntax cannot hide unreadable test options');
  assert.equal(remote.executor?.runnerExecution, true);
  assert.notEqual(remote.executor?.cwd, box.repo);
});


// Test-first module-closure control: a local barrel is executable registration, not textual metadata.
test('a registration re-export chain with imported opaque options uses its runner [C7]', async () => {
  const box = cpuLoadFixture(e2e, { registrationHelper: true, importedOptions: true,
    binding: 'register', importBinding: 'launch as register', moduleSpecifier: './registration-barrel.js',
    declaration: 'options' });
  const remote = await box.runGate();
  assert.equal(remote.result.status, 0, remote.result.context);
  assert.equal(box.requestsMade().length, 1, 'a local re-export closure cannot hide registration with unreadable options');
  assert.equal(remote.executor?.liveLease, true);
  assert.equal(remote.executor?.runnerExecution, true);
  assert.notEqual(remote.executor?.cwd, box.repo);
});


// AFTER-only: wrapping a registration function does not make its executable provenance readable.
test('a local exported registration wrapper with opaque options uses its runner [C7]', async () => {
  const box = cpuLoadFixture(e2e, { registrationHelper: 'wrapper', importedOptions: true,
    binding: 'register', importBinding: 'launch as register', moduleSpecifier: './registration-barrel.js',
    declaration: 'options' });
  const remote = await box.runGate();
  assert.equal(remote.result.status, 0, remote.result.context);
  assert.equal(box.requestsMade().length, 1);
  assert.equal(remote.executor?.runnerExecution, true);
  assert.notEqual(remote.executor?.cwd, box.repo);
});

// AFTER-only: a fully readable lifecycle-only closure still proves ordinary work.
test('a readable false test with a local lifecycle helper stays local [C7]', async () => {
  const box = cpuLoadFixture(e2e, { lifecycleHelper: true, declaration: '{ cpuLoad: false }' });
  const local = await box.runGate();
  assert.equal(local.result.status, 0, local.result.context);
  assert.equal(box.requestsMade().length, 0);
  assert.equal(local.executor?.liveLease, true);
  assert.equal(local.executor?.runnerExecution, false);
  assert.equal(local.executor?.cwd, box.repo);
});
