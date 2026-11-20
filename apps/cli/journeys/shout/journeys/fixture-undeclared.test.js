/** @pullboard-test-input source-cell apps/cli gate runners */
/** Refuse Chrome launched from an undeclared test file, through the real gate [C7,O5]. */
import assert from 'node:assert/strict';
import {
  spawnSync,
} from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  tmpdir,
} from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  test,
} from 'node:test';
import {
  testsNeedBrowser,
} from '../../../../../packages/gate/index.js';
import {
  copyPackageFiles,
} from '../../../../../packages/runners/index.js';
import {
  packageFiles,
} from '../../../../../packages/runners/index.js';

test('cli.journeys-shout-journeys-fixture-undeclared.the-view-fixture-refuses-to-launch: the view fixture refuses to launch Chrome from an undeclared test file [C7,O5]', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-view-browser-slot-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['bin', 'machine']) mkdirSync(join(root, name));
  // Shipped code without test files or the CLI's fixtures (copied back below): the run executes the gate, and a smaller tree commits and scans faster [C7].
  const source = resolve(import.meta.dirname, '../../../../..');
  copyPackageFiles(source, root, { files: packageFiles(source).filter(file => !file.startsWith('apps/cli/tests/') && !/\.test\.js$/u.test(file)) });
  mkdirSync(join(root, 'test'));
  // The tests under test import the real cockpit harness from this checkout by URL: copying its import closure scanned the whole source tree and cost about 100 s [C7].
  const harness = pathToFileURL(resolve(source, 'apps/cli/tests/fixtures/cockpit/harness.js')).href;

  /** Exercise the actual view launcher and always stop any stand-in it owns, including a failing baseline. */
  const body = (name, binding) => `
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
${binding}
test('cli.journeys-shout-journeys-fixture-undeclared.the-budget-view-launch: ${name} view launch', async () => {
  appendFileSync(process.env.FIXTURE_MARKERS, '${name}=' + process.env.PULLBOARD_TEST_BROWSER_SLOT + '\\n');
  const profile = join(process.cwd(), '${name}-profile');
  mkdirSync(profile);
  let stop;
  try {
    const view = ${name === 'held' ? '{ startSnapshotChrome }' : 'await import(process.env.FIXTURE_HARNESS)'};
    const browser = await view.startSnapshotChrome(process.env.FIXTURE_BROWSER, profile, { onOwned: owned => { stop = owned; } });
    await browser.stop();
  } finally { await stop?.(); }
});
`;
  writeFileSync(join(root, 'test/classified-view.test.js'), `// pullboard: browser${body('held', `import { startSnapshotChrome } from '${harness}';`)}`);
  writeFileSync(join(root, 'test/hidden-view.test.js'), body('none', ''));
  const browser = join(root, 'view-browser-stand-in');
  writeFileSync(browser, `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const profile = process.argv.find(arg => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
appendFileSync(process.env.FIXTURE_LAUNCHES, basename(profile) + '\\n');
mkdirSync(profile, { recursive: true });
writeFileSync(join(profile, 'DevToolsActivePort'), '9333\\n/devtools/browser/fixture\\n');
setInterval(() => {}, 1000); // Protocol lifetime: the owner terminates this stand-in process group.
`);
  chmodSync(browser, 0o755);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_') || key.startsWith('PULLBOARD_GATE_SLOT_') || key.startsWith('PULLBOARD_TEST_BROWSER_')) delete env[key];
  }
  for (const key of ['NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'PULLBOARD_BROWSER_SLOT_HELD', 'PULLBOARD_TEST_FILE', 'PULLBOARD_CHROME']) delete env[key];
  Object.assign(env, { PULLBOARD_HOME: join(root, 'home'), PULLBOARD_MACHINE_HOME: join(root, 'machine'),
    FIXTURE_HARNESS: harness, FIXTURE_BROWSER: browser, FIXTURE_MARKERS: join(root, 'markers'), FIXTURE_LAUNCHES: join(root, 'launches') });
  // A committed main, so the runner can read its accepted main for test file budgets.
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'fixture']]) {
    const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(await testsNeedBrowser(root, ['test/classified-view.test.js']), true, 'the first line declares the browser');
  assert.equal(await testsNeedBrowser(root, ['test/hidden-view.test.js']), false, 'no first-line marker, no browser');
  const run = spawnSync(process.execPath, ['packages/gate/src/io/run/tests.js', 'test/classified-view.test.js', 'test/hidden-view.test.js'],
    { cwd: root, env, encoding: 'utf8' });
  const output = `${run.stdout}\n${run.stderr}`;
  assert.notEqual(run.status, 0, output);
  assert.match(output, /\[BROWSER_UNDECLARED\] test\/hidden-view\.test\.js launched Chrome/u);
  assert.deepEqual(readFileSync(join(root, 'markers'), 'utf8').trim().split('\n').sort(), ['held=held', 'none=none']);
  assert.deepEqual(readFileSync(join(root, 'launches'), 'utf8').trim().split('\n'), ['held-profile'],
    'only the declared worker starts the stand-in; the undeclared worker never spawns it');
});
