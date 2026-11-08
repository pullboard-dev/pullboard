/** @pullboard-test-input source-tree */
/** @pullboard-test-loads packages/gate/src/shell/browser-admission.js */
/** Browser admission reads each test file's first-line declaration, and the launcher enforces it at run time [C7]. */
import { copyPackageFiles } from '../packages/runners/index.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { BROWSER_MARKER, browserBoundFiles, checkNeedsBrowser, testsNeedBrowser } from '../packages/gate/index.js';
import { browserInCall } from '../packages/gate/index.js';
import { declaresBrowser } from '../packages/gate/src/core/browser-declaration.js';


/** Create source files for a fixture whose modules must never execute during admission. */
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
  const guard = `--import=${new URL('../packages/gate/src/shell/browser-slot-guard.js', import.meta.url).href}`;
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
  copyPackageFiles(root, foreign);
  const good = commitSourceFixture(foreign);
  for (const command of [configured, ...commands]) {
    assert.equal(await checkNeedsBrowser(foreign, command, { env }), true, `a foreign project cannot borrow the command name: ${command}`);
  }

  // A private copy of the production admission models its own trusted source repository.
  const { checkNeedsBrowser: classifyPrivate } = await import(pathToFileURL(join(foreign, 'packages/gate/src/shell/browser-admission.js')).href);
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

/** A module that records its own evaluation, so a test can prove admission never runs what it reads. */
const EXECUTES = "import { writeFileSync } from 'node:fs'; writeFileSync(new URL('../executed', import.meta.url), 'bad');\n";

test('clause 1: a test file needs a browser only when its first line is // pullboard: browser [C7]', async t => {
  assert.equal(BROWSER_MARKER, '// pullboard: browser');
  const root = sourceFixture(t, {
    'package.json': '{"type":"module"}\n',
    'test/chrome-fixture.js': "throw new Error('admission must never launch or evaluate Chrome');\n",
    'test/declared.test.js': `${BROWSER_MARKER}\nimport './chrome-fixture.js';\n${EXECUTES}`,
    'test/declared-crlf.test.js': `\uFEFF${BROWSER_MARKER}  \r\nimport './chrome-fixture.js';\n`,
    'test/launcher.test.js': `import { startChrome } from './chrome-fixture.js';\nvoid startChrome;\n${EXECUTES}`,
    'test/direct.test.js': "import { spawnSync } from 'node:child_process';\nspawnSync('google-chrome', ['--version']);\n",
    'test/second-line.test.js': `/** A browser test whose marker is not the first line. */\n${BROWSER_MARKER}\n`,
    'test/near.test.js': '//pullboard: browser\n',
    'test/suffix.test.js': `${BROWSER_MARKER}s\n`,
    'test/plain.test.js': "import assert from 'node:assert/strict';\nvoid assert;\n",
  });
  for (const file of ['declared', 'declared-crlf']) {
    assert.equal(await testsNeedBrowser(root, [`test/${file}.test.js`]), true, `${file}: the first line declares the browser`);
  }
  for (const file of ['launcher', 'direct', 'second-line', 'near', 'suffix', 'plain']) {
    assert.equal(await testsNeedBrowser(root, [`test/${file}.test.js`]), false,
      `${file}: no exact first-line marker, no browser, whatever the file imports or spawns`);
  }
  assert.equal(await testsNeedBrowser(root, ['test/plain.test.js', 'test/declared.test.js']), true, 'one declared file puts the selection on a browser lease');
  assert.equal(await testsNeedBrowser(root, [join(root, 'test/declared.test.js')]), true, 'an absolute in-root path reads the same declaration');
  assert.deepEqual(await browserBoundFiles(root, ['test/plain.test.js', 'test/declared.test.js', 'test/launcher.test.js', 'test/declared-crlf.test.js']),
    ['test/declared.test.js', 'test/declared-crlf.test.js'], 'the per-file set is exactly the declared files');
  for (const files of [undefined, [], ['test/missing.test.js'], [join(root, '../outside.test.js')]]) {
    assert.equal(await testsNeedBrowser(root, files), true, `a selection with no readable declaration keeps browser capacity: ${JSON.stringify(files)}`);
  }
  assert.equal(existsSync(join(root, 'executed')), false, 'reading a declaration never evaluates the file or its imports');
  assert.equal(declaresBrowser(`${BROWSER_MARKER}\n`), true);
  assert.equal(declaresBrowser(`\n${BROWSER_MARKER}\n`), false, 'a blank first line is not the marker');

  // A frozen check reads the declarations of the files it names, from the working tree or the submitted commit.
  mkdirSync(join(root, 'bin'), { recursive: true });
  copyPackageFiles(resolve(import.meta.dirname, '..'), root, { files: ['bin/run-tests.js'] });
  const env = { ...process.env, NODE_OPTIONS: '', PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter) };
  assert.equal(await checkNeedsBrowser(root, 'node bin/run-tests.js test/declared.test.js', { env }), true);
  assert.equal(await checkNeedsBrowser(root, 'node bin/run-tests.js test/launcher.test.js', { env }), false,
    'a check over an undeclared file that imports the launcher takes no browser lease');
  const commit = commitSourceFixture(root);
  writeFileSync(join(root, 'test/declared.test.js'), "import './chrome-fixture.js';\n");
  assert.equal(await testsNeedBrowser(root, ['test/declared.test.js']), false, 'live admission reads the current checkout');
  assert.equal(await testsNeedBrowser(root, ['test/declared.test.js'], { commit }), true, 'review admission reads the submitted commit');
  assert.equal(await checkNeedsBrowser(root, 'node bin/run-tests.js test/declared.test.js', { env, commit }), true,
    'a review check follows the exact submitted commit rather than a later checkout edit');

  // Every listed production caller decides through these functions, and the reader parses no imports.
  const repository = resolve(import.meta.dirname, '..');
  const reader = readFileSync(join(repository, 'packages/gate/src/shell/browser-admission.js'), 'utf8');
  assert.doesNotMatch(reader, /module-imports|browser-module-reach|browser-launch-source|importsIn|commonJsIn/u, 'the browser decision parses no import graph');
  const callers = ['bin/run-tests.js', 'packages/gate/src/shell/test-run.js', 'packages/gate/src/shell/test-file-dispatch.js',
    'packages/gate/src/shell/gate-submit.js', 'packages/gate/src/shell/gate-static-check.js', 'packages/gate/src/shell/private-check-admission.js',
    'packages/landing/src/shell/main-red.js', 'packages/landing/src/shell/landing-deferred-run.js', 'packages/landing/src/shell/landing-doctrine.js',
    'packages/landing/src/core/land-local-guard.js', 'packages/items/src/shell/outside-verify.js', 'packages/sandbox/src/shell/push-receipt-smoke.js',
    'apps/cli/src/shell/commands/check.js', 'apps/cli/src/shell/commands/submit.js', 'apps/cli/src/shell/commands/verify.js',
    'apps/cli/src/shell/commands/push-receipts.js'];
  for (const caller of callers) {
    const source = readFileSync(join(repository, caller), 'utf8');
    assert.match(source, /\b(?:checkNeedsBrowser|testsNeedBrowser|browserBoundFiles)\b/u, `${caller} decides browser need through the declaration reader`);
    assert.doesNotMatch(source, /(?:checkNeedsBrowser|testsNeedBrowser|browserBoundFiles)\([^)]*byLaunch|browser-module-reach|browser-scan-cache/u, `${caller} passes no import-graph classification option`);
  }
});

/** Git's environment without hook or outer-repository variables, so fixture git commands see only their own repo. */
function plainGitEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
}

/**
 * A private runner checkout with the real runner, packages and Chrome fixture, a private machine home, and a
 * stand-in Chrome that only logs its arguments.
 */
function runnerFixture(t, tests) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-browser-by-launch-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'bin'));
  mkdirSync(join(root, 'test'));
  mkdirSync(join(root, 'machine'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  copyPackageFiles(resolve(import.meta.dirname, '..'), root);
  for (const helper of ['chrome-fixture.js', 'chrome-graceful-shutdown.js', 'chrome-launch-args.js', 'fixture-child.js']) copyFileSync(resolve(import.meta.dirname, helper), join(root, 'test', helper));
  for (const [path, source] of Object.entries(tests)) writeFileSync(join(root, path), source);
  const chrome = join(root, 'stand-in-browser');
  writeFileSync(chrome, '#!/bin/sh\nprintf "%s\\n" "$1" >> "$PULLBOARD_FIXTURE_LAUNCHES"\n');
  chmodSync(chrome, 0o755);
  // A committed main, so the runner can read its accepted main for test file budgets.
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'fixture']]) {
    const result = spawnSync('git', args, { cwd: root, env: plainGitEnvironment(), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  /**
   * Run the copied runner on named files; return its output and records. PULLBOARD_CHROME names the stand-in
   * only when asked, so a run can show which guard layer refused.
   */
  function run(files, { chromeSetting = false } = {}) {
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
    /** Split one record file the fixture tests append to into its lines. */
    const lines = text => text.split('\n').filter(Boolean).sort();
    const markers = existsSync(join(root, 'markers')) ? lines(readFileSync(join(root, 'markers'), 'utf8')) : [];
    const launches = existsSync(join(root, 'launches')) ? lines(readFileSync(join(root, 'launches'), 'utf8')) : [];
    return { status: result.status, output: `${result.stdout}\n${result.stderr}`, markers, launches };
  }
  return { root, run };
}

test('clause 2: an undeclared test file that launches Chrome through the shared launcher fails BROWSER_UNDECLARED [C7,O5]', async t => {
  const launch = name => `test('${name} launches the stand-in browser', async () => {
  appendFileSync(process.env.PULLBOARD_FIXTURE_MARKERS, \`${name}=\${process.env.PULLBOARD_TEST_BROWSER_SLOT ?? 'unset'}\\n\`);
  const browser = launchChromeProcess({ executable: process.env.FIXTURE_BROWSER, args: ['${name}'] });
  await browser.stopped;
  await browser.close();
});
`;
  const imports = "import { appendFileSync } from 'node:fs';\nimport { test } from 'node:test';\nimport { launchChromeProcess } from './chrome-fixture.js';\n";
  const runner = runnerFixture(t, {
    'test/declared.test.js': `${BROWSER_MARKER}\n${imports}${launch('declared')}`,
    'test/undeclared.test.js': `${imports}${launch('undeclared')}`,
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
  const ran = runner.run(['test/declared.test.js', 'test/undeclared.test.js', 'test/child.test.js']);
  assert.notEqual(ran.status, 0, ran.output);
  assert.match(ran.output, /\[BROWSER_UNDECLARED\] test\/undeclared\.test\.js launched Chrome/u, 'the undeclared launch fails by file name');
  assert.match(ran.output, /make its first line \/\/ pullboard: browser/u, 'the refusal names the one-line fix');
  assert.match(ran.output, /\[BROWSER_UNDECLARED\] test\/child\.test\.js launched Chrome/u, 'a launch from the file\'s child process fails by file name');
  assert.match(ran.output, /^ok \d+ - declared launches the stand-in browser/mu, ran.output);
  assert.deepEqual(ran.markers, ['declared=held', 'undeclared=none'], 'the declared file holds a browser lease; the undeclared one runs without');
  assert.deepEqual(ran.launches, ['declared'], 'only the declared file started a browser; the refused launches never started one');

  // Browser starts that never pass through test/chrome-fixture.js are refused best effort by the slot guard.
  const direct = runnerFixture(t, {
    'test/direct.test.js': `import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
test('direct starts the configured browser path itself', () => { spawnSync(process.env.FIXTURE_BROWSER, ['direct']); });
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
  });
  const directFiles = ['test/direct.test.js', 'test/shell.test.js', 'test/spawned.test.js'];
  const spawned = direct.run(directFiles, { chromeSetting: true });
  assert.notEqual(spawned.status, 0, spawned.output);
  for (const file of directFiles) {
    assert.match(spawned.output, new RegExp(`\\[BROWSER_UNDECLARED\\] test/${file.slice(5).replaceAll('.', '\\.')} launched Chrome`, 'u'),
      `${file}: a direct browser spawn fails by file name`);
  }
  assert.deepEqual(spawned.launches, [], 'no direct, shell, exec or child spawn started the browser without a declaration');
  for (const [method, input] of [
    ['spawn', ['google-chrome', ['--headless']]], ['execFileSync', ['/opt/x/chromium', []]], ['spawnSync', ['headless_shell']],
    ['spawn', ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', []]], ['execSync', ['cd /tmp && google-chrome-stable --version']],
    ['spawnSync', ['bash', ['-lc', 'exec chromium-browser']]], ['spawn', ['echo chrome', [], { shell: true }]], ['fork', ['x.js', [], { execPath: '/usr/bin/chromium' }]],
  ]) assert.ok(browserInCall(method, input), `${method} ${JSON.stringify(input)} names a browser by basename`);
  for (const [method, input] of [['spawnSync', ['git', ['status']]], ['execSync', ['printf chrome-fixture.js']], ['spawn', [process.execPath, ['-e', 'google-chrome']]]]) {
    assert.equal(browserInCall(method, input), null, `${method} ${JSON.stringify(input)} is not a browser`);
  }
});

/** Shared-launcher calls: a module that makes one, other than the launchers themselves, starts a browser. */
const LAUNCH_CALL = '(^|[^[:alnum:]_])(startChrome|launchChromeProcess|requireBrowserSlot)[[:space:]]*\\(';
/** View-fixture calls that start Chrome through test/cockpit/fixture.js's startSnapshotChrome. */
const VIEW_LAUNCH_CALL = '(^|[^[:alnum:]_])(startSnapshotChrome|openSnapshotChrome|searchFor)[[:space:]]*\\(';
/** Relative module requests in static and literal dynamic imports. */
const RELATIVE_IMPORT = `(from[[:space:]]*|import[[:space:]]*\\([[:space:]]*|import[[:space:]]+)['"]\\.[^'"]+['"]`;

/**
 * Search every tracked module in the working tree with one git grep, so the scan follows whatever paths are
 * tracked today and names none of its own. Exit 1 is git grep's "no match".
 *
 * @param {string} repository
 * @param {string[]} args
 * @returns {string}
 */
function grepModules(repository, args) {
  const result = spawnSync('git', ['grep', '-z', '-I', ...args, '--', '*.js', '*.mjs', '*.cjs'],
    { cwd: repository, env: plainGitEnvironment(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.ok(result.status === 0 || result.status === 1, result.stderr);
  return result.stdout;
}

/**
 * Tracked test files whose own source, or a tracked module they import by relative path, calls a shared
 * Chrome launcher: the files that launch Chrome on main.
 *
 * @param {string} repository
 * @returns {string[]}
 */
function chromeLaunchingTests(repository) {
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: repository, env: plainGitEnvironment(), encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  const modules = new Set(listed.stdout.split('\0').filter(path => /\.(?:m?js|cjs)$/u.test(path)));
  /** The tracked modules whose source matches one pattern. */
  const matching = (...args) => new Set(grepModules(repository, ['-l', ...args]).split('\0').filter(Boolean));
  const viewFixture = matching('-F', '-e', 'cockpit/fixture.js');
  const launchers = new Set([...matching('-E', '-e', LAUNCH_CALL), ...[...matching('-E', '-e', VIEW_LAUNCH_CALL)].filter(path => viewFixture.has(path))]);
  const requests = new Map();
  for (const line of grepModules(repository, ['-o', '-E', '-e', RELATIVE_IMPORT]).split('\n')) {
    const split = line.indexOf('\0');
    if (split < 0) continue;
    const request = /['"](\.[^'"]+)['"]$/u.exec(line.slice(split + 1))?.[1];
    if (request) requests.set(line.slice(0, split), [...requests.get(line.slice(0, split)) ?? [], request]);
  }
  /** Resolve a relative request the way the test files write them: with or without a .js or .mjs suffix. */
  const target = (importer, request) => [request, `${request}.js`, `${request}.mjs`]
    .map(candidate => join(dirname(importer), candidate)).find(candidate => modules.has(candidate));
  const launches = path => !['test/chrome-fixture.js', 'test/cockpit/fixture.js'].includes(path) && launchers.has(path);
  return [...modules].filter(path => /\.test\.m?js$/u.test(path)).filter(test => {
    const seen = new Set();
    const stack = [test];
    while (stack.length) {
      const path = stack.pop();
      if (seen.has(path)) continue;
      seen.add(path);
      if (launches(path)) return true;
      for (const request of requests.get(path) ?? []) {
        const next = target(path, request);
        if (next) stack.push(next);
      }
    }
    return false;
  }).sort();
}

test('clause 4: every test file that launches Chrome on main carries the browser declaration [C7]', async () => {
  const repository = resolve(import.meta.dirname, '..');
  // This file's own launches are fixture sources run by nested runners with their own declarations.
  const launching = chromeLaunchingTests(repository).filter(file => file !== 'test/test-resources.test.js');
  assert.ok(launching.length > 20, `the scan finds the real Chrome journeys: ${launching.length}`);
  const declared = new Set(await browserBoundFiles(repository, launching));
  const undeclared = launching.filter(file => !declared.has(file));
  assert.deepEqual(undeclared, [], `make the first line of each ${BROWSER_MARKER}`);
  for (const file of ['test/journeys.test.js', 'test/relay-pairing.test.js', 'test/cockpit/stable.test.js', 'test/cockpit/chrome-owner-probe.mjs',
    'packages/kernel/tests/seal.test.js', 'docs/shots/shots.test.js', 'test/hosted-shapes.test.js']) {
    assert.equal(declaresBrowser(readFileSync(join(repository, file), 'utf8')), true, `${file} launches Chrome and declares it`);
  }
});
