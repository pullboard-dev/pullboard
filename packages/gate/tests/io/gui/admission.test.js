/** GUI requirements are explicit file metadata and fresh execution-user domain observations [C7,V4]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkNeedsGui } from '../../../src/io/gui/admission.js';
import { testsNeedGui } from '../../../src/io/gui/admission.js';
import { guiSession } from '../../../src/io/gui/session.js';
import { cleanGitEnvironment } from '../../../../git/index.js';
import { runFixtureGit } from '../../../../../apps/cli/tests/fixtures/child.js';

test('GUI admission reads an explicit file marker rather than Chrome headless arguments [C7,V4]', t => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-gui-marker-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'native.test.js'), '/** @pullboard-test-gui */\nconst flags = ["--headless=new"];');
  writeFileSync(join(root, 'ordinary.test.js'), 'const flags = ["--headless=new"];');
  assert.equal(testsNeedGui(root, ['native.test.js']), true);
  assert.equal(testsNeedGui(root, ['ordinary.test.js']), false);
  assert.equal(testsNeedGui(root, ['missing.test.js']), false);
});

test('GUI-domain observations distinguish confirmed presence, known absence, and unknown [C7,V4]', () => {
  const calls = [];
  const present = guiSession({ platform: 'darwin', getuid: () => 501, run: (...args) => { calls.push(args); return { status: 0, signal: null }; } });
  assert.equal(present, true);
  assert.deepEqual(calls[0].slice(0, 2), ['/bin/launchctl', ['print', 'gui/501']]);
  assert.equal(calls[0][2].timeout, 1000);
  assert.equal(guiSession({ platform: 'darwin', getuid: () => 501, run: () => ({ status: 113, stderr: 'Could not find domain for\n' }) }), false);
  assert.equal(guiSession({ platform: 'darwin', getuid: () => 501, run: () => ({ status: 125, stderr: 'Could not print domain: 125: Domain does not support specified action\n' }) }), null);
  assert.equal(guiSession({ platform: 'darwin', getuid: () => 501, run: () => ({ status: 0, error: new Error('timeout') }) }), null);
  assert.equal(guiSession({ platform: 'darwin', getuid: () => 501, run: () => ({ status: null, signal: 'SIGKILL' }) }), null);
  assert.equal(guiSession({ platform: 'darwin', getuid: () => -1, run: () => { throw new Error('must not run'); } }), null);
  assert.equal(guiSession({ platform: 'linux', run: () => { throw new Error('must not run'); } }), null);
});

test('GUI marker text in code does not turn an ordinary file into desktop work [C7,V4]', t => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-gui-literal-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'literal.test.js'), '/** Ordinary source test. */\nconst example = "/** @pullboard-test-gui */";');
  assert.equal(testsNeedGui(root, ['literal.test.js']), false, 'code strings are not header annotations');
  writeFileSync(join(root, 'licensed.test.js'), '/** License. */\n/** @pullboard-test-gui */\nconst flags = ["--headless=new"];');
  assert.equal(testsNeedGui(root, ['licensed.test.js']), true, 'the explicit marker may follow a leading license comment');
});


/** Create committed GUI revisions with real Git while keeping classification independent of live source. */
function committedGuiFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-gui-commit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...cleanGitEnvironment(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const command = (...args) => runFixtureGit(['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, env });
  command('init', '-q');
  command('config', 'user.name', 'GUI fixture');
  command('config', 'user.email', 'gui@example.invalid');
  mkdirSync(join(root, 'packages/gate/src/io/run'), { recursive: true });
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'apps/cli/src/io/run/tests.js'), '// Private classifier fixture; never executed.\n');
  writeFileSync(join(root, 'test/native.test.js'), '/** Ordinary test. */\n');
  command('add', '.');
  command('commit', '-qm', 'Ordinary source');
  const base = command('rev-parse', 'HEAD');
  writeFileSync(join(root, 'test/native.test.js'), '/** @pullboard-test-gui */\n');
  writeFileSync(join(root, 'test/added.test.js'), '/** @pullboard-test-gui */\n');
  command('add', '.');
  command('commit', '-qm', 'Committed desktop source');
  const desktop = command('rev-parse', 'HEAD');
  return { root, command, base, desktop };
}

test('GUI admission classifies the exact committed selection and opaque tree, never live markers [C7,V4]', async t => {
  const box = committedGuiFixture(t);
  const check = 'node apps/cli/src/io/run/tests.js test/native.test.js';
  box.command('checkout', '-q', '--detach', box.base);
  assert.equal(await checkNeedsGui(box.root, check), false);
  assert.equal(await checkNeedsGui(box.root, check, { commit: box.desktop }), true, 'a patch-only marker requests actual desktop admission');
  assert.equal(await checkNeedsGui(box.root, 'opaque-check', { commit: box.desktop }), true, 'opaque checks inspect committed added test files');
  assert.equal(await checkNeedsGui(box.root, 'node apps/cli/src/io/run/tests.js test/added.test.js', { commit: box.desktop }), true, 'selected newly committed files need not exist live');
  box.command('checkout', '-q', '--detach', box.desktop);
  assert.equal(await checkNeedsGui(box.root, check), true);
  assert.equal(await checkNeedsGui(box.root, check, { commit: box.base }), false, 'live annotations cannot replace the selected committed source');
  assert.equal(await checkNeedsGui(box.root, 'opaque-check', { commit: box.base }), false);
});

test('unreadable or nonregular committed GUI metadata retains desktop admission [C7,V4]', async t => {
  const box = committedGuiFixture(t);
  const check = 'node apps/cli/src/io/run/tests.js test/native.test.js';
  assert.equal(await checkNeedsGui(box.root, check, { commit: '0'.repeat(40) }), true);
  assert.equal(await checkNeedsGui(box.root, check, { commit: 'not-a-commit' }), true);
  box.command('checkout', '-q', '--detach', box.base);
  symlinkSync('../missing-target', join(box.root, 'test/link.test.js'));
  box.command('add', 'test/link.test.js');
  box.command('commit', '-qm', 'Nonregular test input');
  const link = box.command('rev-parse', 'HEAD');
  assert.equal(await checkNeedsGui(box.root, 'node apps/cli/src/io/run/tests.js test/link.test.js', { commit: link }), true);
});
