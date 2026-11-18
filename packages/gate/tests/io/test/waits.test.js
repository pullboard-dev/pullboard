/** @pullboard-test-input test-tree */
/** Static wait/port guard: source strings are inspected, never executed [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { testWaitSites } from '../../../src/io/test/waits.js';
import { testWaitReport } from '../../../src/io/test/waits.js';
import { testWaitGrowth } from '../../../src/io/test/waits.js';
import { testWaitCounts } from '../../../src/io/test/waits.js';
import { tightenTestWaitBaseline } from '../../../src/io/test/waits.js';

const ROOT = fileURLToPath(new URL('../../../../..', import.meta.url));

/** Retain the actual diagnostic location and category while avoiding incidental wording coupling. */
function sites(source) {
  return testWaitSites(source, 'test/example.test.js').map(({ path, line, kind }) => ({ path, line, kind }));
}

test('gate.io-test-waits.the-wait-lint-names-real-timer: the wait lint names real timer aliases, sleeps and sole-resolver promises [C7]', () => {
  const source = [
    "import { setTimeout as delay } from 'node:timers/promises';",
    'await delay(20);',
    'await sleep(30);',
    'await new Promise(done => setTimeout(done, 40));',
    "import * as timers from 'node:timers/promises';",
    'await timers.setTimeout(50);',
  ].join('\n');
  assert.deepEqual(sites(source), [2, 3, 4, 6].map(line => ({ path: 'test/example.test.js', line, kind: 'sleep' })));
});

/** Preserve coverage for wrapped timeout callbacks that only resolve their Promise. */
test('gate.io-test-waits.the-wait-lint-names-wrapped-sole: the wait lint names wrapped sole-resolver timer callbacks [C7]', () => {
  const source = [
    'await new Promise(resolve => setTimeout(() => resolve(), 20));',
    'await new Promise(resolve => setTimeout(() => { resolve(); }, 20));',
    'await new Promise(function (resolve) { setTimeout(function () { resolve(); }, 20); });',
    'await new Promise(resolve => setTimeout(() => resolve(value), 20));',
  ].join('\n');
  assert.deepEqual(sites(source), [1, 2, 3, 4].map(line => ({ path: 'test/example.test.js', line, kind: 'sleep' })));
});

/** Cover timer waits that reach the test through native callback and promisify forms. */
test('gate.io-test-waits.the-wait-lint-names-multi-argument: the wait lint names multi-argument executors, promisified timers and test completion timers [C7]', () => {
  const source = [
    "import { promisify } from 'node:util';",
    'const wait = promisify(setTimeout);',
    'await wait(10);',
    'await new Promise((resolve, reject) => setTimeout(resolve, 5));',
    "import { test } from 'node:test';",
    "test('callback wait', (t, done) => setTimeout(done, 100));",
  ].join('\n');
  assert.deepEqual(sites(source), [3, 4, 6].map(line => ({ path: 'test/example.test.js', line, kind: 'sleep' })));
});

/** Cover default and namespace ESM bindings with the same bounded timer wait patterns. */
test('gate.io-test-waits.the-wait-lint-resolves-default-imports: the wait lint resolves default imports and callback-style completion parameters [C7]', () => {
  const source = [
    "import { promisify as toPromise } from 'node:util';",
    'const pause = toPromise(setTimeout);',
    'await pause(10);',
    "import * as util from 'node:util';",
    'const namespacePause = util.promisify(setTimeout);',
    'await namespacePause(10);',
    "import utilDefault from 'node:util';",
    'const defaultPause = utilDefault.promisify(setTimeout);',
    'await defaultPause(10);',
    'await new Promise(function (resolve, reject) { setTimeout(resolve, 5); });',
    "import defaultTest from 'node:test';",
    "defaultTest('callback wait', (t, done) => setTimeout(done, 100));",
    "import timersDefault from 'node:timers/promises';",
    'await timersDefault.setTimeout(10);',
    "defaultTest('wrapped callback wait', (t, done) => setTimeout(() => done(), 100));",
  ].join('\n');
  assert.deepEqual(sites(source), [3, 6, 9, 10, 12, 14, 15].map(line => ({ path: 'test/example.test.js', line, kind: 'sleep' })));
});

test('gate.io-test-waits.the-wait-lint-names-fixed-delay: the wait lint names fixed-delay polling and its actual line [C7]', () => {
  const source = [
    "import { setTimeout as delay } from 'node:timers/promises';",
    'const INTERVAL = 25;',
    'while (!ready()) {',
    '  const observation = inspect();',
    '  await delay(INTERVAL);',
    '}',
  ].join('\n');
  assert.deepEqual(sites(source), [
    { path: 'test/example.test.js', line: 5, kind: 'poll' },
    { path: 'test/example.test.js', line: 5, kind: 'sleep' },
  ]);
});

/** Cover inline and named callbacks on positive-delay fixed intervals. */
test('gate.io-test-waits.the-wait-lint-names-active-fixed: the wait lint names active fixed-interval callbacks [C7]', () => {
  const source = [
    'const h = setInterval(() => { if (ok()) { clearInterval(h); go(); } }, 200);',
    '/** Check the observable condition. */',
    'function check() { if (ready()) finish(); }',
    'setInterval(check, 20);',
  ].join('\n');
  assert.deepEqual(sites(source), [1, 4].map(line => ({ path: 'test/example.test.js', line, kind: 'poll' })));
});

test('gate.io-test-waits.the-wait-lint-distinguishes-a-following: the wait lint distinguishes a following wait from a one-statement poll body [C7]', () => {
  const source = "import {setTimeout as delay} from 'node:timers/promises';\nwhile (!ready()) observe();\nawait delay(20);\n";
  assert.deepEqual(sites(source), [{ path: 'test/example.test.js', line: 3, kind: 'sleep' }]);
});

test('gate.io-test-waits.the-wait-lint-names-fixed-tcp: the wait lint names fixed TCP binds and connects including constant aliases [C7]', () => {
  const source = [
    'const FIXED = 31337;',
    'const PORT = FIXED;',
    'server.listen(PORT);',
    "server.listen({ port: 4890, host: '127.0.0.1' });",
    "connect(12345, '127.0.0.1');",
    'server.listen(0);',
    'server.listen({port: 0});',
    'client.connect(address.port);',
  ].join('\n');
  assert.deepEqual(sites(source), [3, 4, 5].map(line => ({ path: 'test/example.test.js', line, kind: 'port' })));
});

test('gate.io-test-waits.the-wait-lint-leaves-deadline-failures: the wait lint leaves deadline failures, event watchdogs and ephemeral ports clean [C7]', () => {
  const source = [
    'setTimeout(() => reject(new Error("late")), 1000);',
    'setTimeout(() => child.kill(), 1000);',
    'await Promise.race([event(), new Promise(done => setTimeout(() => done(false), 500))]);',
    'await new Promise(done => { setTimeout(done, 500); child.once("close", done); });',
    'await Promise.race([ready, new Promise((resolve) => { let interval; interval = setInterval(() => { clearInterval(interval); resolve(false); }, 500); })]);',
    'setInterval(() => {}, 100);',
    'const signal = AbortSignal.timeout(1000);',
    'await once(server, "listening");',
    'server.listen(0);',
    'server.listen({port: 0});',
  ].join('\n');
  assert.deepEqual(sites(source), []);
});

test('gate.io-test-waits.the-wait-lint-ignores-quoted-fixtures: the wait lint ignores quoted fixtures, comments and regexes while retaining interpolated code [C7]', () => {
  const source = [
    '// await sleep(100); server.listen(4000);',
    'const fixture = "await sleep(100); server.listen(4000);";',
    'const regex = /await sleep(100); server.listen(4000);/;',
    'const template = `await sleep(100); ${await sleep(5)}`;',
  ].join('\n');
  assert.deepEqual(sites(source), [{ path: 'test/example.test.js', line: 4, kind: 'sleep' }]);
});

/** Generated executable fixtures are real test programs; their source location stays in the authoring file. */
test('gate.io-test-waits.the-wait-lint-scans-fixed-polls: the wait lint scans fixed polls in emitted JavaScript and node-shebang fixture templates [C7]', () => {
  const source = [
    "writeFileSync(join(repo, 'child.js'), `",
    'const wait = setInterval(() => { if (ready()) { clearInterval(wait); finish(); } }, 5);',
    '`);',
    'const program = `#!/usr/bin/env node',
    'const check = () => { if (existsSync(marker)) finish(); };',
    'const poll = setInterval(check, 20);',
    '`;',
    "writeFileSync(ssh, program, {mode: 0o700});",
    'function otherFixture() {',
    '  const program = `#!/usr/bin/env node',
    '  setInterval(checkOther, 30);',
    '  `;',
    '  writeFileSync(otherExecutable, program);',
    '}',
  ].join('\n');
  assert.deepEqual(sites(source), [2, 6, 11].map(line => ({ path: 'test/example.test.js', line, kind: 'poll' })));
});

/** A quoted example becomes fixture source only at an explicit program-producing write. */
test('gate.io-test-waits.the-wait-lint-leaves-unwritten-templates: the wait lint leaves unwritten templates and written text examples alone [C7]', () => {
  const source = [
    'const example = `setInterval(check, 20);`;',
    "writeFileSync('notes.txt', `setInterval(check, 20);`);",
    "writeFileSync('child.js', `",
    'const ignored = "setInterval(check, 20);";',
    'setInterval(() => {}, 1000);',
    '`);',
  ].join('\n');
  assert.deepEqual(sites(source), []);
});

/** An escaped child placeholder is literal template text and cannot swallow a later timer diagnostic. */
test('gate.io-test-waits.the-wait-lint-retains-generated-polls: the wait lint retains generated polls after escaped template placeholders [C7]', () => {
  const source = [
    "writeFileSync('child.js', `",
    "const text = '\\${example}';",
    'setInterval(check, 20);',
    '`);',
  ].join('\n');
  assert.deepEqual(sites(source), [{ path: 'test/example.test.js', line: 3, kind: 'poll' }]);
});

test('gate.io-test-waits.the-wait-debt-baseline-refuses-new: the wait debt baseline refuses new files, category swaps and growth and only tightens [C7]', () => {
  const original = testWaitSites('await sleep(5);\nserver.listen(1234);', 'test/example.test.js');
  const baseline = testWaitCounts(original);
  assert.deepEqual(testWaitGrowth(original, baseline), []);
  const grown = testWaitSites('await sleep(5);\nawait sleep(6);', 'test/example.test.js');
  assert.equal(testWaitGrowth(grown, baseline).length, 1, 'removing a port cannot buy another sleep');
  assert.throws(() => tightenTestWaitBaseline(grown, baseline), /test\/example\.test\.js:2:/u);
  assert.deepEqual(tightenTestWaitBaseline(original.slice(0, 1), baseline), { 'test/example.test.js': { sleep: 1 } });
  assert.deepEqual(tightenTestWaitBaseline([], baseline), {});
  const fresh = testWaitSites('await sleep(5);', 'test/fresh.test.js');
  assert.deepEqual(testWaitGrowth(fresh, baseline), fresh);
  assert.deepEqual(baseline, { 'test/example.test.js': { sleep: 1, port: 1 } }, 'a refused update mutates no existing allowance');
});

test('gate.io-test-waits.the-repository-has-no-new-sleeps: the repository has no new sleeps, fixed poll intervals or fixed TCP ports [C7]', () => {
  const baseline = JSON.parse(readFileSync(new URL('../../../data/baselines/test-waits-baseline.json', import.meta.url), 'utf8'));
  assert.deepEqual(testWaitGrowth(testWaitReport(ROOT), baseline), []);
});

/** Catch inline promisified waits without treating unrelated functions as timers. */
test('gate.io-test-waits.inline-promisified-timers-are-waits: inline promisified timers are waits [C7]', () => {
  const source = [
    "import { promisify as p } from 'node:util';",
    "import util from 'node:util';",
    'await p(setTimeout)(50);',
    'await util.promisify(setTimeout)(50);',
    'await unrelated(setTimeout)(50);',
  ].join('\n');
  assert.deepEqual(sites(source), [3, 4].map(line => ({ path: 'test/example.test.js', line, kind: 'sleep' })));
});
