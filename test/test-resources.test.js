/** @pullboard-test-input test-tree */
/** @pullboard-test-input source-tree */
/** @pullboard-test-loads src/browser-admission.js */
/** Browser admission follows current test dependencies without executing them [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { browserBoundFiles, checkNeedsBrowser, testsNeedBrowser } from '../src/browser-admission.js';
import { browserInCall } from '../src/browser-slot-guard.js';

const TEST_RUNNER = resolve(import.meta.dirname, '../bin/run-tests.js');

/** Create source files for a dependency graph whose modules must never execute during admission. */
function sourceFixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-browser-admission-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  return root;
}

/** Commit a private source fixture with a deterministic identity for immutable review coverage. */
function commitSourceFixture(root) {
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'fixture']]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  assert.equal(head.status, 0, head.stderr);
  return head.stdout.trim();
}

test("the repo's own static checks never take a browser slot [C7]", async t => {
  const root = resolve(import.meta.dirname, '..');
  const env = { ...process.env, NODE_OPTIONS: '', PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter) };
  const configured = JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8')).staticChecks;
  assert.equal(await checkNeedsBrowser(root, configured, { env }), false, 'the declared static command is browser-free');
  const commands = [
    'node bin/static-style-checks.js',
    'node bin/pullboard.js doctrine check',
    'node bin/pullboard.js spec check',
    'node bin/checks/file-size.js',
    'node bin/checks/empty-catch.js',
  ];
  for (const command of commands) assert.equal(await checkNeedsBrowser(root, command, { env }), false, command);
  assert.equal(await checkNeedsBrowser(root, configured, { env: { ...env, NODE_OPTIONS: '--import=unknown.mjs' } }), true);
  const guard = `--import=${new URL('../src/browser-slot-guard.js', import.meta.url).href}`;
  assert.equal(await checkNeedsBrowser(root, configured, { env: { ...env, NODE_OPTIONS: `${guard} --require=unknown.cjs` } }), true);
  for (const command of [
    'node bin/unknown.js', 'node bin/pullboard.js view', 'node bin/pullboard.js doctrine check extra',
    'node bin/static-style-checks.js extra', 'node bin/checks/file-size.js --browser',
    'env node bin/static-style-checks.js', 'nice node bin/static-style-checks.js',
    'sh -c "node bin/static-style-checks.js"', 'npm run static',
    'node --require=unknown.cjs bin/static-style-checks.js',
    'node --import=unknown.mjs bin/static-style-checks.js',
    'node --eval="import(\'./browser.mjs\')"',
    'node bin/static-style-checks.js; node browser.js',
    'node bin/static-style-checks.js && node browser.js',
    'node bin/static-style-checks.js | node browser.js',
    'node bin/static-style-checks.js > result',
    'node bin/static-style-checks.js &',
    'node $(printf bin/static-style-checks.js)',
    'node bin/static-style-checks.js\nnode browser.js',
  ]) assert.equal(await checkNeedsBrowser(root, command, { env }), true, command);

  const doctrine = '# Doctrine\n\n## Checks\n'
    + '- C9 [approved, must] Source files stay bounded. | gate: check node bin/checks/file-size.js | count: 0\n'
    + '- C8 [approved, must] Empty catches explain their handling. | gate: check node bin/checks/empty-catch.js | count: 0\n';
  const foreign = sourceFixture(t, {
    'package.json': '{"name":"pullboard","type":"module"}\n',
    'pullboard.json': readFileSync(join(root, 'pullboard.json'), 'utf8'),
    'DOCTRINE.md': doctrine,
    'bin/browser-rule.js': "import { writeFileSync } from 'node:fs'; writeFileSync(new URL('../rule-executed', import.meta.url), 'bad');\n",
  });
  cpSync(join(root, 'src'), join(foreign, 'src'), { recursive: true });
  cpSync(join(root, 'bin'), join(foreign, 'bin'), { recursive: true });
  const good = commitSourceFixture(foreign);
  for (const command of [configured, ...commands]) {
    assert.equal(await checkNeedsBrowser(foreign, command, { env }), true, `a foreign project cannot borrow the command name: ${command}`);
  }

  // A private copy of the production classifier models its own trusted source repository.
  const { checkNeedsBrowser: classifyPrivate } = await import(pathToFileURL(join(foreign, 'src/browser-admission.js')).href);
  const aggregates = [configured, 'node bin/pullboard.js doctrine check'];
  for (const command of aggregates) assert.equal(await classifyPrivate(foreign, command, { env, commit: good }), false, 'the trusted branch accepts only known rules');
  const unknown = doctrine + '- C10 [approved, must] Run another check. | gate: check node bin/browser-rule.js | count: 0\n';
  writeFileSync(join(foreign, 'DOCTRINE.md'), unknown);
  const bad = commitSourceFixture(foreign);
  writeFileSync(join(foreign, 'DOCTRINE.md'), doctrine);
  for (const command of aggregates) {
    assert.equal(await classifyPrivate(foreign, command, { env, commit: bad }), true, 'an unknown committed rule needs a browser even when working doctrine is safe');
    assert.equal(await classifyPrivate(foreign, command, { env }), true, 'HEAD doctrine, not its uncommitted replacement, controls execution');
    assert.equal(await classifyPrivate(foreign, command, { env, commit: good }), false, 'an explicit clean revision does not borrow rules from the current HEAD');
  }
  const customConfig = JSON.parse(readFileSync(join(foreign, 'pullboard.json'), 'utf8'));
  customConfig.practice = 'CUSTOM.md';
  writeFileSync(join(foreign, 'pullboard.json'), `${JSON.stringify(customConfig)}\n`);
  writeFileSync(join(foreign, 'CUSTOM.md'), unknown);
  const custom = commitSourceFixture(foreign);
  for (const command of aggregates) assert.equal(await classifyPrivate(foreign, command, { env, commit: custom }), true, 'a configured doctrine path cannot hide its arbitrary rule');
  assert.equal(existsSync(join(foreign, 'rule-executed')), false, 'classification never executes a rule or its script');
  customConfig.practice = 'DOCTRINE.md';
  writeFileSync(join(foreign, 'pullboard.json'), `${JSON.stringify(customConfig)}\n`);
  writeFileSync(join(foreign, 'DOCTRINE.md'), doctrine);
  commitSourceFixture(foreign);
  assert.equal(await classifyPrivate(foreign, configured, { env }), false, 'the later path controls begin with a known browser-free aggregate');
  assert.equal(await classifyPrivate(foreign, configured, { env, commit: '0'.repeat(40) }), true, 'missing committed sources fail closed');

  const shadow = join(foreign, 'shadow');
  mkdirSync(shadow);
  writeFileSync(join(shadow, 'node'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(shadow, 'node'), 0o755);
  assert.equal(await checkNeedsBrowser(root, configured, { env: { ...env, PATH: [shadow, env.PATH].join(delimiter) } }), true, 'a shadow Node is not the current runtime');
  const entry = join(foreign, 'bin/static-style-checks.js');
  rmSync(entry);
  symlinkSync(join(root, 'bin/static-style-checks.js'), entry);
  assert.equal(await classifyPrivate(foreign, 'node bin/static-style-checks.js', { env }), true, 'a symlinked static entry point is uncertain');
  rmSync(entry);
  mkdirSync(entry);
  assert.equal(await classifyPrivate(foreign, 'node bin/static-style-checks.js', { env }), true, 'a directory is not the static script');
  rmSync(entry, { recursive: true });
  assert.equal(await classifyPrivate(foreign, 'node bin/static-style-checks.js', { env }), true, 'a missing static script is uncertain');
});

test('ordinary focused tests need no browser and admission never executes their modules [C7]', async t => {
  const root = sourceFixture(t, {
    'test/plain.test.js': "import '../helper.js'; import assert from 'node:assert/strict';",
    'helper.js': "import { writeFileSync } from 'node:fs'; writeFileSync(new URL('./executed', import.meta.url), 'bad');",
  });
  assert.equal(await testsNeedBrowser(root, ['./test/plain.test.js']), false);
  assert.equal(await testsNeedBrowser(root, [join(root, 'test/plain.test.js')]), false);
  assert.equal(existsSync(join(root, 'executed')), false);
});

test('a focused test acquires browser admission through its helper and current source edits [C7]', async t => {
  const root = sourceFixture(t, {
    'test/plain.test.js': "import '../helper.js';",
    'helper.js': "import assert from 'node:assert/strict';",
    'test/chrome-fixture.js': "throw new Error('admission must never launch or evaluate Chrome');",
  });
  assert.equal(await testsNeedBrowser(root, ['test/plain.test.js']), false);
  writeFileSync(join(root, 'helper.js'), "import './test/chrome-fixture.js';");
  assert.equal(await testsNeedBrowser(root, ['test/plain.test.js']), true,
    'admission reads the edited dependency, rather than a cached or committed graph');
});

test('full, cockpit and uncertain test selections reserve browser capacity [C7]', async t => {
  const root = sourceFixture(t, {
    'test/computed.test.js': "const module = './helper.js'; await import(module);",
    'test/broken.test.js': 'this is not valid javascript @',
  });
  for (const files of [undefined, [], ['test/cockpit/items.test.js'], ['test/missing.test.js'],
    ['test/computed.test.js'], ['test/broken.test.js'], [join(root, '../outside.test.js')]]) {
    assert.equal(await testsNeedBrowser(root, files), true);
  }
});

test('module launchers and dynamic builtins keep browser admission conservative [C7]', async t => {
  const root = sourceFixture(t, {
    'test/workers.test.js': "import { Worker } from 'node:worker_threads'; void Worker;",
    'test/cluster.test.js': "import cluster from 'node:cluster'; void cluster;",
    'test/vm.test.js': "import vm from 'node:vm'; void vm;",
    'test/builtin.test.js': "const builtin = process.getBuiltinModule('node:worker_threads'); void builtin;",
    'test/computed-builtin.test.js': "const builtin = process['getBuiltinModule']('node:cluster'); void builtin;",
    'test/computed-expression.test.js': "const builtin = process['get' + 'BuiltinModule']('node:worker_threads'); void builtin;",
    'test/escaped-builtin.test.js': "const builtin = process['getBuiltin\\u004dodule']('node:cluster'); void builtin;",
    'test/optional-builtin.test.js': "const builtin = process?.['getBuiltinModule']('node:cluster'); void builtin;",
    'test/destructured-builtin.test.js': "const { getBuiltinModule: load } = process; void load;",
    'test/computed-process-alias.test.js': "const proc = process; const builtin = proc[property]; void builtin;",
  });
  for (const file of ['workers', 'cluster', 'vm', 'builtin', 'computed-builtin', 'computed-expression',
    'escaped-builtin', 'optional-builtin', 'destructured-builtin', 'computed-process-alias']) {
    assert.equal(await testsNeedBrowser(root, [`test/${file}.test.js`]), true, file);
  }

  mkdirSync(join(root, 'src'), { recursive: true });
  copyFileSync(resolve(import.meta.dirname, '../src/module-imports.js'), join(root, 'src/module-imports.js'));
  copyFileSync(resolve(import.meta.dirname, '../src/js-lex.js'), join(root, 'src/js-lex.js'));
  writeFileSync(join(root, 'test/parser.test.js'), "import '../src/module-imports.js';\n");
  assert.equal(await testsNeedBrowser(root, ['test/parser.test.js']), false,
    'the reviewed V8 compile-only import parser may use node:vm without evaluating the test graph');
});

test('only actual CommonJS loader words trigger browser admission in JavaScript source [C7]', async t => {
  const root = sourceFixture(t, {
    'test/mentions.test.js': "// require('./chrome-fixture.js') and createRequire are only comments\nconst note = 'require createRequire';\nconst pattern = /require|createRequire/;",
    'test/require.test.js': 'const load = require;',
    'test/create-require.test.js': "import { createRequire } from 'node:module'; const load = createRequire(import.meta.url);",
    'test/escaped-require.test.js': 'const load = requ\\u0069re;',
    'test/escaped-create-require.test.js': 'const load = createRequ\\u0069re;',
    'test/escaped-text.test.js': '// requ\\u0069re and createRequ\\u0069re are just comment text\nconst note = "requ\\u0069re createRequ\\u0069re";',
    'test/module-computed.test.js': "import * as runtime from 'node:module'; const load = runtime['create' + 'Require'];",
    'test/browser.test.cjs': "require('./chrome-fixture.js');",
  });
  assert.equal(await testsNeedBrowser(root, ['test/mentions.test.js']), false,
    'comments, strings, and regular-expression text do not represent CommonJS loading');
  assert.equal(await testsNeedBrowser(root, ['test/require.test.js']), true);
  assert.equal(await testsNeedBrowser(root, ['test/create-require.test.js']), true);
  assert.equal(await testsNeedBrowser(root, ['test/escaped-require.test.js']), true);
  assert.equal(await testsNeedBrowser(root, ['test/escaped-create-require.test.js']), true);
  assert.equal(await testsNeedBrowser(root, ['test/escaped-text.test.js']), false,
    'Unicode escape text in comments and strings does not represent an identifier');
  assert.equal(await testsNeedBrowser(root, ['test/module-computed.test.js']), true,
    'node:module can create a loader through aliases or computed properties');
  assert.equal(await testsNeedBrowser(root, ['test/browser.test.cjs']), true);
});

test('frozen checks classify only explicit source-backed test commands [C7]', async t => {
  const root = sourceFixture(t, {
    'test/plain.test.js': "import '../helper.js'; import assert from 'node:assert/strict';",
    'helper.js': "import { writeFileSync } from 'node:fs'; writeFileSync(new URL('./executed', import.meta.url), 'bad');",
  });
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'test'), { recursive: true });
  cpSync(resolve(import.meta.dirname, '../src'), join(root, 'src'), { recursive: true });
  copyFileSync(TEST_RUNNER, join(root, 'bin/run-tests.js'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(root, 'test/resources.test.js'), "import { test } from 'node:test'; test('a non-browser check does not wait for the browser slot', () => {});\n");
  const command = 'out=$(node bin/run-tests.js --test-name-pattern "a non-browser check does not wait for the browser slot" test/resources.test.js 2>&1); printf "%s\\n" "$out"; printf "%s\\n" "$out" | grep -Eq "^[[:space:]]*ok [0-9]+ - .*a non-browser check does not wait for the browser slot" && printf "%s\\n" "$out" | grep -Eq "^# fail 0$"';
  const classifyEnv = { ...process.env, NODE_OPTIONS: '', PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter) };
  assert.equal(await checkNeedsBrowser(root, command, { env: classifyEnv }), false);
  assert.equal(await checkNeedsBrowser(root, command, { env: classifyEnv }), false,
    'the supported captured runner form remains statically classifiable');
  assert.equal(await checkNeedsBrowser(root, command, {
    env: { ...classifyEnv, NODE_OPTIONS: '--import=unclassified-loader.mjs' },
  }), true, 'an unknown Node preload still fails closed to browser admission');
  assert.equal(await checkNeedsBrowser(root, command, {
    env: { ...classifyEnv, NODE_OPTIONS: `--import=${new URL('../src/browser-slot-guard.js', import.meta.url).href}` },
  }), false, "the runner's own launch guard preload, inherited from a browser-free test file, is not an unknown preload [C7,O5]");
  assert.equal(await checkNeedsBrowser(root, command, {
    env: { ...classifyEnv, NODE_OPTIONS: `--import=${new URL('../src/browser-slot-guard.js', import.meta.url).href} --import=x.mjs` },
  }), true, 'the guard preload does not excuse another preload beside it');

  const runnerPath = join(root, 'bin/run-tests.js');
  rmSync(runnerPath);
  symlinkSync('/bin/echo', runnerPath);
  const symlinkFallbacks = [];
  assert.equal(await checkNeedsBrowser(root, command, { env: classifyEnv, onFallback: decision => symlinkFallbacks.push(decision) }), true,
    'a symlinked runner outside the repository is browser-required');
  assert.equal(symlinkFallbacks[0].file, 'bin/run-tests.js');
  assert.match(symlinkFallbacks[0].reason, /regular in-repository file/u);
  rmSync(runnerPath);
  mkdirSync(runnerPath);
  assert.equal(await checkNeedsBrowser(root, command, { env: classifyEnv }), true, 'a directory runner fails closed');
  rmSync(runnerPath, { recursive: true, force: true });
  copyFileSync(TEST_RUNNER, runnerPath);
  for (const opaque of [
    'node bin/run-tests.js test/plain.test.js; touch side-effect',
    'node bin/run-tests.js test/*.test.js',
    'node bin/run-tests.js test/journeys.test.js',
    'node bin/run-tests.js test/cockpit/brief.test.js',
    'node --test-reporter spec bin/run-tests.js test/plain.test.js',
    'npm test',
  ]) assert.equal(await checkNeedsBrowser(root, opaque), true, opaque);

  copyFileSync(resolve(import.meta.dirname, './fixture-child.js'), join(root, 'test/fixture-child.js'));
  writeFileSync(join(root, 'test/known-fixture.test.js'), "import './fixture-child.js';\n");
  assert.equal(await testsNeedBrowser(root, ['test/known-fixture.test.js']), false,
    'the path-reviewed shared fixture child helper remains CPU-only');
  writeFileSync(join(root, 'test/fixture-child.js'), "import { spawn } from 'node:child_process'; spawn('git', ['status']);\n");
  assert.equal(await testsNeedBrowser(root, ['test/known-fixture.test.js']), false,
    'the reviewed path exception does not depend on a content hash');
  writeFileSync(join(root, 'test/fixture-child.js'), "import { spawn } from 'node:child_process'; spawn('google-chrome', []);\n");
  assert.equal(await testsNeedBrowser(root, ['test/known-fixture.test.js']), true,
    'a literal Chrome launcher still overrides the path exception');

  copyFileSync(resolve(import.meta.dirname, './fixture-child.js'), join(root, 'test/fixture-child.js'));
  writeFileSync(join(root, 'test/known-fixture.test.js'), "import { runFixtureGit as git } from './fixture-child.js';\n");
  assert.equal(await testsNeedBrowser(root, ['test/known-fixture.test.js']), false,
    'the narrowly reviewed fixed-Git helper remains CPU-only');

  for (const importer of [
    "import { runFixtureChild as child } from './fixture-child.js';\n",
    "import * as fixture from './fixture-child.js';\n",
    "import { runFixtureChild as child } from './fixture-child.js'; child(process.env.BROWSER_BIN, []);\n",
    "import * as fixture from './fixture-child.js'; fixture.runFixtureChild(process.env.BROWSER_BIN, []);\n",
    "export { runFixtureGit } from './fixture-child.js';\n",
    "const fixture = await import('./fixture-child.js');\n",
    "import fixture from './fixture-child.js';\n",
    "import './fixture-child.js';\nimport { runFixtureChild } from './fixture-child.js';\n",
    "import { runFixtureGit } from './fixture-child.js';\nimport { runFixtureChild } from './fixture-child.js';\n",
    "import { runFixtureGit } from './fixture-child.js';\nimport { runFixtureChild } from '.\\x2ffixture-child.js';\n",
  ]) {
    writeFileSync(join(root, 'test/known-fixture.test.js'), importer);
    const decisions = [];
    assert.equal(await testsNeedBrowser(root, ['test/known-fixture.test.js'], {
      onFallback: decision => decisions.push(decision),
    }), true, importer);
    assert.equal(decisions.length, 1, importer);
    assert.equal(decisions[0].file, 'test/known-fixture.test.js');
    assert.match(decisions[0].reason, /caller-selected process target/u);
  }

  writeFileSync(join(root, 'test/launcher.test.js'), "import { spawn } from 'node:child_process'; spawn('google-chrome', []);\n");
  const chromeFallbacks = [];
  assert.equal(await testsNeedBrowser(root, ['test/launcher.test.js'], { onFallback: decision => chromeFallbacks.push(decision) }), true,
    'a test source that names a Chrome launcher remains browser-required');
  assert.deepEqual(chromeFallbacks, [], 'known Chrome launchers reserve browser capacity without uncertainty diagnostics');
  writeFileSync(join(root, 'test/computed-launch.test.js'), "import { spawn } from 'node:child_process'; spawn(process.env.BROWSER, []);\n");
  const fallbackReasons = [];
  assert.equal(await testsNeedBrowser(root, ['test/computed-launch.test.js'], { onFallback: decision => fallbackReasons.push(decision) }), true,
    'an unknown computed child-process target remains browser-required');
  assert.equal(fallbackReasons.length, 1);
  assert.equal(fallbackReasons[0].file, 'test/computed-launch.test.js');
  assert.match(fallbackReasons[0].reason, /child_process/u);

  const commit = commitSourceFixture(root);
  assert.equal(await checkNeedsBrowser(root, command, { commit, env: classifyEnv }), false,
    'review admission reads test and runner blobs from the immutable commit');
  writeFileSync(join(root, 'helper.js'), "import './test/chrome-fixture.js';");
  assert.equal(await testsNeedBrowser(root, ['test/plain.test.js']), true, 'live checks follow the current checkout');
  assert.equal(await checkNeedsBrowser(root, command, { commit, env: classifyEnv }), false,
    'review checks follow the exact submitted commit rather than a later checkout edit');
});

test('Unicode ranges do not turn ordinary tests into browser files [C7]', async t => {
  const root = sourceFixture(t, {
    'test/plain.test.js': "import '../config.js';",
    'config.js': String.raw`export const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/u;`,
    'test/escaped-loader.test.js': String.raw`const load = requ\u0069re;`,
    'test/escaped-braced-loader.test.js': String.raw`const load = requ\u{69}re;`,
  });
  assert.equal(await testsNeedBrowser(root, ['test/plain.test.js']), false,
    'a control-character regex in a shared config helper does not reserve a browser slot');
  assert.equal(await testsNeedBrowser(root, ['test/escaped-loader.test.js']), true,
    'an escaped loader identifier still requires conservative browser admission');
  assert.equal(await testsNeedBrowser(root, ['test/escaped-braced-loader.test.js']), true);
});

/** The 42 files that launched Chrome in core-197's full census run on main 8b8dc50e (shout 11748). */
const CENSUS_LAUNCHED = [
  'test/chrome-fixture.test.js', 'test/cockpit/activity.test.js', 'test/cockpit/addresses.test.js', 'test/cockpit/agents.test.js',
  'test/cockpit/demo.test.js', 'test/cockpit/doctrine.test.js', 'test/cockpit/fixture.test.js', 'test/cockpit/item-waits.test.js',
  'test/cockpit/items.test.js', 'test/cockpit/layout.test.js', 'test/cockpit/live.test.js', 'test/cockpit/local-origin.test.js',
  'test/cockpit/needs.test.js', 'test/cockpit/newcomer.test.js', 'test/cockpit/perf.test.js', 'test/cockpit/projects.test.js',
  'test/cockpit/prose.test.js', 'test/cockpit/references.test.js', 'test/cockpit/relay.test.js', 'test/cockpit/roadmap.test.js',
  'test/cockpit/scope.test.js', 'test/cockpit/search.test.js', 'test/cockpit/shared-wait.test.js', 'test/cockpit/shout-overlap.test.js',
  'test/cockpit/shouts.test.js', 'test/cockpit/snapshot.test.js', 'test/cockpit/spec.test.js', 'test/cockpit/stats.test.js',
  'test/relay-agent.test.js', 'test/relay-approval-delivery.test.js', 'test/relay-browser-fixture.test.js', 'test/relay-browser.test.js',
  'test/relay-device-confirmation.test.js', 'test/relay-person-actions.test.js', 'test/relay-person-credential.test.js',
  'test/relay-person-outbox.test.js', 'test/relay-person-page.test.js', 'test/relay-person-requests.test.js',
  // Later addition: #978's independently proven two-Chrome pairing case (outside ACCEPT 1443).
  'test/relay-pairing.test.js',
  'test/relay-setup-once.test.js', 'test/relay-snapshot-recovery.test.js', 'test/relay-snapshot-size.test.js', 'test/seal.test.js',
];

/** Git's environment without hook or outer-repository variables, so fixture git commands see only their own repo. */
function plainGitEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
}

/**
 * A private runner checkout with the real runner, src/ and Chrome fixture, a private machine home whose
 * settings file says whether gate.browserByLaunch is on, and a stand-in Chrome that only logs its arguments.
 */
function runnerFixture(t, tests) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-browser-by-launch-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'bin'));
  mkdirSync(join(root, 'test'));
  mkdirSync(join(root, 'machine'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  copyFileSync(TEST_RUNNER, join(root, 'bin/run-tests.js'));
  cpSync(resolve(import.meta.dirname, '../src'), join(root, 'src'), { recursive: true });
  for (const helper of ['chrome-fixture.js', 'chrome-launch-args.js', 'fixture-child.js']) copyFileSync(resolve(import.meta.dirname, helper), join(root, 'test', helper));
  for (const [path, source] of Object.entries(tests)) writeFileSync(join(root, path), source);
  const chrome = join(root, 'stand-in-browser');
  writeFileSync(chrome, '#!/bin/sh\nprintf "%s\\n" "$1" >> "$PULLBOARD_FIXTURE_LAUNCHES"\n');
  chmodSync(chrome, 0o755);
  const init = spawnSync('git', ['init', '-q'], { cwd: root, env: plainGitEnvironment(), encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  /**
   * Run the copied runner on named files with gate.browserByLaunch set as given; return its output and records.
   * PULLBOARD_CHROME names the stand-in only when asked, so a run can show which guard layer refused.
   */
  function run(byLaunch, files, { chromeSetting = false } = {}) {
    writeFileSync(join(root, 'machine/settings.json'), `${JSON.stringify({ gate: { browserByLaunch: byLaunch } })}\n`);
    for (const record of ['markers', 'launches']) rmSync(join(root, record), { force: true });
    const env = plainGitEnvironment();
    for (const key of Object.keys(env)) {
      if (key.startsWith('PULLBOARD_GATE_SLOT_') || key.startsWith('PULLBOARD_TEST_BROWSER_')) delete env[key];
    }
    for (const key of ['NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'PULLBOARD_BROWSER_SLOT_HELD', 'PULLBOARD_TEST_FILE', 'PULLBOARD_CHROME']) delete env[key];
    if (chromeSetting) env.PULLBOARD_CHROME = chrome;
    Object.assign(env, { PULLBOARD_MACHINE_HOME: join(root, 'machine'), PULLBOARD_FIXTURE_MARKERS: join(root, 'markers'),
      PULLBOARD_FIXTURE_LAUNCHES: join(root, 'launches'), FIXTURE_BROWSER: chrome });
    const result = spawnSync(process.execPath, ['bin/run-tests.js', ...files], { cwd: root, env, encoding: 'utf8' });
    /** Read one record file the fixture tests append to, empty when nothing wrote it. */
    const lines = name => existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8').split('\n').filter(Boolean) : [];
    return { status: result.status, output: `${result.stdout}\n${result.stderr}`, markers: lines('markers').sort(), launches: lines('launches').sort() };
  }
  return { root, run };
}

/** A fixture test body that records which browser slot marker its worker set: held, none, or unset. */
const RECORD_MARKER = name => `import { appendFileSync } from 'node:fs';
import { test } from 'node:test';
test('${name} records its browser slot marker', () => {
  appendFileSync(process.env.PULLBOARD_FIXTURE_MARKERS, \`${name}=\${process.env.PULLBOARD_TEST_BROWSER_SLOT ?? 'unset'}\\n\`);
});
`;

test('only a file that reaches a browser launch takes a browser slot [C7,O5]', async t => {
  const root = sourceFixture(t, {
    'test/chrome-fixture.js': "throw new Error('admission must never launch or evaluate Chrome');",
    'test/helpers.test.js': "import { spawnSync } from 'node:child_process';\nimport { createWaiter, createEvaluator } from './chrome-fixture.js';\nvoid spawnSync; void createWaiter; void createEvaluator;",
    'test/finder.test.js': "import { findChromeExecutable } from './chrome-fixture.js';\nvoid findChromeExecutable;",
    'test/launch.test.js': "import { startChrome } from './chrome-fixture.js';\nvoid startChrome;",
    'test/renamed.test.js': "import { launchChromeProcess as begin } from './chrome-fixture.js';\nvoid begin;",
    'test/wrapped.test.js': "import { open } from '../wrapper.js';\nvoid open;",
    'wrapper.js': "import { startChrome as launch } from './test/chrome-fixture.js';\nexport const open = () => launch();",
    'test/everything.test.js': "import * as chrome from './chrome-fixture.js';\nvoid chrome;",
    'test/direct.test.js': "import { spawnSync } from 'node:child_process';\nspawnSync(process.env.PULLBOARD_CHROME, ['--version']);",
    'test/spawner.test.js': "import { spawnSync } from 'node:child_process';\nspawnSync('git', ['status']);",
  });
  const byLaunch = file => testsNeedBrowser(root, [file], { byLaunch: true });
  assert.equal(await byLaunch('test/helpers.test.js'), false,
    'importing launch-free Chrome fixture helpers and child_process takes no browser slot by launch');
  assert.equal(await byLaunch('test/spawner.test.js'), false, 'a process starter with no Chrome reference takes no browser slot by launch');
  for (const file of ['launch', 'renamed', 'wrapped', 'everything', 'finder', 'direct']) {
    assert.equal(await byLaunch(`test/${file}.test.js`), true, `${file}: a graph that reaches a Chrome launch takes the browser slot`);
  }
  assert.equal(await byLaunch('test/cockpit/items.test.js'), true,
    'cockpit files keep the browser slot until test/cockpit/fixture.js carries the launch guard (#741)');
  for (const file of ['helpers', 'spawner']) {
    assert.equal(await testsNeedBrowser(root, [`test/${file}.test.js`], { byLaunch: false }), true,
      `${file}: with gate.browserByLaunch off, classification is exactly today's`);
  }

  const repository = resolve(import.meta.dirname, '..');
  const listed = spawnSync('git', ['ls-files', '-z', 'test'], { cwd: repository, env: plainGitEnvironment(), encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  const tracked = listed.stdout.split('\0').filter(path => /\.test\.(?:js|mjs)$/u.test(path)).sort();
  const bound = await browserBoundFiles(repository, tracked, { byLaunch: true });
  assert.ok(!bound.includes('test/runners.test.js'), 'runner subprocess fixture source data does not launch a browser in the runner test process');
  const missed = CENSUS_LAUNCHED.filter(file => tracked.includes(file) && !bound.includes(file));
  assert.deepEqual(missed, [], 'every file that launched Chrome in the census is classified browser-bound');
  // Cockpit and journey files stay bound by rule until #741 guards the view fixture; the rest must reach a launch.
  const reached = bound.filter(file => !file.startsWith('test/cockpit/') && file !== 'test/journeys.test.js');
  // 21 Oct: 21, since #977's relay-local-origin.test.js really launches WebKit and Chrome to prove the Safari local route.
  // 22 Oct: 22, since #978's relay-pairing.test.js really launches two Chromes to pair a second browser.
  assert.ok(reached.length <= 22,
    `about 42 of ${tracked.length} test files are browser-bound by launch (the census's 15 non-cockpit launchers, plus cockpit and journey files until #741); got ${bound.length}, ${reached.length} outside cockpit: ${reached.join(', ')}`);

  const runner = runnerFixture(t, {
    'test/plain.test.js': `import { spawnSync } from 'node:child_process';\nvoid spawnSync;\n${RECORD_MARKER('plain')}`,
    'test/launcher.test.js': `import { launchChromeProcess } from './chrome-fixture.js';\n${RECORD_MARKER('launcher')}
test('launcher starts the stand-in browser inside its slot', async () => {
  const browser = launchChromeProcess({ executable: process.env.FIXTURE_BROWSER, args: ['launcher'] });
  await browser.stopped;
  await browser.close();
});
`,
  });
  const on = runner.run(true, ['test/plain.test.js', 'test/launcher.test.js']);
  assert.equal(on.status, 0, on.output);
  assert.deepEqual(on.markers, ['launcher=held', 'plain=none'],
    'by launch, only the launching file takes a browser slot; the child_process file runs without one');
  assert.deepEqual(on.launches, ['launcher'], 'a file holding the slot launches as before');
  const off = runner.run(false, ['test/plain.test.js', 'test/launcher.test.js']);
  assert.equal(off.status, 0, off.output);
  assert.deepEqual(off.markers, ['launcher=unset', 'plain=unset'], 'with the setting off the runner sets no marker, as today');
});

test('a file that launches Chrome unclassified fails by name [C7,O5]', async t => {
  const hidden = `import { test } from 'node:test';
test('hidden launches through a computed import', async () => {
  const chrome = await import(['.', 'chrome-fixture.js'].join('/'));
  const browser = chrome.launchChromeProcess({ executable: process.env.FIXTURE_BROWSER, args: ['hidden'] });
  await browser.stopped;
  await browser.close();
});
`;
  const runner = runnerFixture(t, {
    'test/hidden.test.js': hidden,
    'test/child.test.js': `import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
test('child launches from a process the test starts', () => {
  const result = spawnSync(process.execPath, ['test/launch-helper.mjs'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
`,
    'test/launch-helper.mjs': "import { launchChromeProcess } from './chrome-fixture.js';\nconst browser = launchChromeProcess({ executable: process.env.FIXTURE_BROWSER, args: ['child'] });\nawait browser.stopped;\nawait browser.close();\n",
  });
  assert.equal(await testsNeedBrowser(runner.root, ['test/hidden.test.js'], { byLaunch: true }), false,
    'the fixture really is misclassified: a computed import hides the launch from the static walk');
  assert.equal(await testsNeedBrowser(runner.root, ['test/child.test.js'], { byLaunch: true }), false,
    'the fixture really is misclassified: the launch is in a child process outside the import graph');
  const on = runner.run(true, ['test/hidden.test.js', 'test/child.test.js']);
  assert.notEqual(on.status, 0, on.output);
  assert.match(on.output, /\[BROWSER_SLOT_REQUIRED\] test\/hidden\.test\.js launched Chrome/u, 'the in-process launch fails by file name');
  assert.match(on.output, /\[BROWSER_SLOT_REQUIRED\] test\/child\.test\.js launched Chrome/u, 'a launch from the file\'s child process fails by file name');
  assert.deepEqual(on.launches, [], 'the refused launches never started a browser outside the slot');
  const off = runner.run(false, ['test/hidden.test.js']);
  assert.equal(off.status, 0, off.output);
  assert.deepEqual(off.launches, ['hidden'], 'with gate.browserByLaunch off the guard is inert and the file launches as today');

  // tests-42's counterexample (shout 11929): browser starts that never pass through test/chrome-fixture.js.
  const direct = runnerFixture(t, {
    'test/direct.test.js': `import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
test('direct starts the configured browser path itself', () => { spawnSync(process.env.FIXTURE_BROWSER, ['direct']); });
`,
    'test/finder.test.js': `import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
test('finder starts the path the normal browser finder returns', async () => {
  const { findChromeExecutable } = await import(['.', 'chrome-fixture.js'].join('/'));
  spawnSync(findChromeExecutable(), ['finder']);
});
`,
    'test/shell.test.js': `import { execSync, spawnSync } from 'node:child_process';
import { test } from 'node:test';
test('shell starts the browser from an sh -c string', () => { spawnSync('sh', ['-c', \`'\${process.env.FIXTURE_BROWSER}' shell\`]); });
test('shell starts the browser through exec', () => { execSync(\`'\${process.env.FIXTURE_BROWSER}' exec\`); });
`,
    'test/spawned.test.js': `import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
test('spawned starts a Node child that starts the browser', () => {
  const result = spawnSync(process.execPath, ['test/direct-helper.mjs'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
});
`,
    'test/direct-helper.mjs': "import { spawnSync } from 'node:child_process';\nspawnSync(process.env.FIXTURE_BROWSER, ['grandchild']);\n",
    'test/static-finder.test.js': "import { findChromeExecutable } from './chrome-fixture.js';\nvoid findChromeExecutable;\n",
  });
  const directFiles = ['test/direct.test.js', 'test/finder.test.js', 'test/shell.test.js', 'test/spawned.test.js'];
  for (const file of directFiles) {
    assert.equal(await testsNeedBrowser(direct.root, [file], { byLaunch: true }), false, `${file}: the fixture really is classified browser-free`);
  }
  assert.equal(await testsNeedBrowser(direct.root, ['test/static-finder.test.js'], { byLaunch: true }), true,
    'importing findChromeExecutable yields a browser path, so it counts as a launch');
  const spawned = direct.run(true, directFiles, { chromeSetting: true });
  assert.notEqual(spawned.status, 0, spawned.output);
  for (const file of directFiles) {
    assert.match(spawned.output, new RegExp(`\\[BROWSER_SLOT_REQUIRED\\] test/${file.slice(5).replaceAll('.', '\\.')} launched Chrome`, 'u'),
      `${file}: a direct browser spawn fails by file name`);
  }
  assert.deepEqual(spawned.launches, [], 'no direct, finder, shell, exec or child spawn started the browser outside the slot');
  for (const [method, input] of [
    ['spawn', ['google-chrome', ['--headless']]], ['execFileSync', ['/opt/x/chromium', []]], ['spawnSync', ['headless_shell']],
    ['spawn', ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', []]], ['execSync', ['cd /tmp && google-chrome-stable --version']],
    ['spawnSync', ['bash', ['-lc', 'exec chromium-browser']]], ['spawn', ['echo chrome', [], { shell: true }]], ['fork', ['x.js', [], { execPath: '/usr/bin/chromium' }]],
  ]) assert.ok(browserInCall(method, input), `${method} ${JSON.stringify(input)} names a browser by basename`);
  for (const [method, input] of [['spawnSync', ['git', ['status']]], ['execSync', ['printf chrome-fixture.js']], ['spawn', [process.execPath, ['-e', 'google-chrome']]]]) {
    assert.equal(browserInCall(method, input), null, `${method} ${JSON.stringify(input)} is not a browser`);
  }
});


test('the actual runner preload stays browser-free while real direct launches stay bound [C7,O5]', async t => {
  const root = sourceFixture(t, {
    'package.json': '{"type":"module"}',
    'test/plain.test.js': "import '../bin/run-tests.js';\n",
    'test/direct.test.js': "import { spawnSync } from 'node:child_process'; spawnSync(process.env.PULLBOARD_CHROME, ['--version']);\n",
  });
  cpSync(resolve(import.meta.dirname, '../src'), join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'bin'));
  copyFileSync(TEST_RUNNER, join(root, 'bin/run-tests.js'));
  commitSourceFixture(root);
  assert.equal(await testsNeedBrowser(root, ['test/plain.test.js'], { byLaunch: true }), false,
    'importing the actual runner and its refusal-only guard must not claim a browser slot');
  assert.equal(await testsNeedBrowser(root, ['test/direct.test.js'], { byLaunch: true }), true,
    'a real direct browser launcher still needs its browser slot');
});
