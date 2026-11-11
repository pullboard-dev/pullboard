/** A self-hosted pre-commit runs from the staged index with the item's companions applied, never the working tree [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { fixtureJoin } from '../../../tests/fixtures/testkit.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);
const HOOK_MODULE = pathToFileURL(resolve(import.meta.dirname, '../../../src/io/hook/composed.js')).href;
const REAL_CLI = pathToFileURL(resolve(import.meta.dirname, '../../../pullboard.js')).href;
const SHIM_IMPORT = "import { value } from '../web/shim.js';\nexport default value;\n";
const REPOINT = 'diff --git a/api/serve.js b/api/serve.js\n--- a/api/serve.js\n+++ b/api/serve.js\n@@ -1,2 +1,2 @@\n'
  + "-import { value } from '../web/shim.js';\n+import { value } from '../web/real.js';\n export default value;\n";

/** Capture a real successful CLI command. */
function run(box, cwd, ...args) {
  const result = box.run(cwd, ...args, '--json');
  assert.equal(result.code, 0, result.err + result.out);
  return JSON.parse(result.out);
}

/** Write fixture files under a checkout. */
function write(root, files) {
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), source);
  }
}

/**
 * A project that hosts its own CLI the way pullboard does: its pre-commit runs apps/cli/pullboard.js from the checkout,
 * and that entry loads api/serve.js, which imports web/shim.js. A web item deletes the shim; its api companion
 * repoints the importer.
 */
function fixture({ fixer = false, companion = true } = {}) {
  const box = helpers.project('true');
  if (fixer) {
    // A fixer rewrites staged .txt files; the composed check hands the real hook to this checkout's CLI.
    const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
    write(box.repo, { 'pullboard.json': JSON.stringify({ ...config, fix: [{ run: 'sh bin/fix.sh' }] }, null, 2),
      'bin/fix.sh': 'for f; do case "$f" in *.txt) printf \'fixed\\n\' >> "$f";; esac; done\n', 'web/value.txt': 'raw\n' });
  }
  write(box.repo, {
    'web/real.js': 'export const value = 1;\n',
    'web/shim.js': "export * from './real.js';\n",
    'web/tests/real.js': 'export const unread = 1;\n',
    'web/data/tests/guard.json': '{}\n',
    'api/journeys/unread.js': 'export const unread = 1;\n',
    'api/serve.js': SHIM_IMPORT,
    'apps/cli/pullboard.js': `const { runComposedHook } = await import(${JSON.stringify(HOOK_MODULE)});\n`
      + 'const composed = await runComposedHook(process.argv[1], process.argv.slice(2), { cwd: process.cwd(), env: process.env });\n'
      + 'if (composed !== null) process.exit(composed);\n'
      + "if (process.env.PB_PROBE) (await import('node:fs')).writeFileSync(process.env.PB_PROBE, JSON.stringify({ dir: import.meta.dirname,"
        + " real: (await import('node:fs')).existsSync(new URL('../../web/real.js', import.meta.url)),"
        + " unread: (await import('node:fs')).existsSync(new URL('../../web/tests/real.js', import.meta.url))"
        + " || (await import('node:fs')).existsSync(new URL('../../api/journeys/unread.js', import.meta.url)),"
        + " data: (await import('node:fs')).existsSync(new URL('../../web/data/tests/guard.json', import.meta.url)) }));\n"
      + "await import('../../api/serve.js');\n"
      + (fixer ? "if (process.env.PULLBOARD_HOOK_COMPOSED === '1') (await import('node:fs')).writeFileSync(process.env.PB_CHECKED_OUT, "
        + "(await import('node:child_process')).execFileSync('git', ['show', ':web/value.txt']));\n"
        + `await import(${JSON.stringify(REAL_CLI)});\n` : ''),
    '.selfhooks/pre-commit': `#!/bin/sh\nroot=$(git rev-parse --show-toplevel)\nexec "${process.execPath}" "$root/apps/cli/pullboard.js" hook pre-commit\n`,
    '.selfhooks/pre-merge-commit': `#!/bin/sh\nroot=$(git rev-parse --show-toplevel)\nexec "${process.execPath}" "$root/apps/cli/pullboard.js" hook pre-merge-commit\n`,
  });
  chmodSync(join(box.repo, '.selfhooks/pre-commit'), 0o755);
  chmodSync(join(box.repo, '.selfhooks/pre-merge-commit'), 0o755);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: seed a self-hosted entry and a shim');
  const api = join(box.dir, 'api-1');
  box.git(box.repo, 'worktree', 'add', '-q', api, '-b', 'api/one');
  assert.match(fixtureJoin(box.run, api, 'api').out, /joined as api-/u);
  const author = run(box, api, 'whoami').id;
  const item = run(box, box.repo, 'add', 'web', 'Delete the web shim', '--specs', 'G1').item.item_id;
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  const claimed = run(box, box.web, 'claim', String(item));
  const builder = claimed.itemFolder ?? box.web;
  const source = box.git(builder, 'rev-parse', 'HEAD').trim();
  const patch = join(box.dir, 'repoint.patch');
  writeFileSync(patch, REPOINT);
  if (companion) run(box, box.repo, 'patch', 'attach', String(item), patch, '--key', 'repoint', '--author', author, '--source', source);
  box.git(box.repo, 'config', 'core.hooksPath', '.selfhooks');
  return { box, builder };
}

test('a staged shim deletion commits cleanly when its attached companion repoints the importer [C7]', () => {
  const { box, builder } = fixture();
  box.git(builder, 'rm', '-q', 'web/shim.js');
  const committed = box.tryGit(builder, 'commit', '-q', '-m', 'refactor(web): delete the shim [G1]');
  assert.equal(committed.status, 0, `${committed.stdout}${committed.stderr}${committed.failure ?? ''}`);
  assert.equal(readFileSync(join(builder, 'api/serve.js'), 'utf8'), SHIM_IMPORT, 'the importer in the working tree is untouched');
  assert.equal(box.git(builder, 'show', 'HEAD:api/serve.js').trim(), SHIM_IMPORT.trim(), 'the companion is checked, never committed');
  assert.notEqual(box.tryGit(builder, 'cat-file', '-e', 'HEAD:web/shim.js').status, 0, 'the shim deletion is committed');
});

test('control: the same entry run from the working tree crashes on the deleted shim [C7]', () => {
  const { box, builder } = fixture();
  box.git(builder, 'rm', '-q', 'web/shim.js');
  const crashed = spawnSync(process.execPath, [join(builder, 'apps/cli/pullboard.js'), 'hook', 'pre-commit'],
    { cwd: builder, env: { ...box.env, PULLBOARD_HOOK_COMPOSED: '1' }, encoding: 'utf8' });
  assert.notEqual(crashed.status, 0);
  assert.match(crashed.stderr, /ERR_MODULE_NOT_FOUND/u);
});

test('a fixer\'s rewrite reaches the real index, so the checked blob is the committed blob [C7]', () => {
  const { box, builder } = fixture({ fixer: true });
  const checked = join(box.dir, 'checked.txt');
  box.env.PB_CHECKED_OUT = checked;
  writeFileSync(join(builder, 'web/value.txt'), 'edited\n');
  box.git(builder, 'add', 'web/value.txt');
  const committed = box.tryGit(builder, 'commit', '-q', '-m', 'feat(web): edit the value [G1]');
  assert.equal(committed.status, 0, `${committed.stdout}${committed.stderr}${committed.failure ?? ''}`);
  const blob = box.git(builder, 'show', 'HEAD:web/value.txt');
  assert.equal(blob.trim(), 'edited\nfixed', 'the fixer\'s bytes are committed');
  assert.equal(readFileSync(checked, 'utf8').trim(), blob.trim(), 'the composed check read the committed bytes');
});

/* These two run the real CLI behind the composed entry (fixer: true), so the lane rule itself is exercised. */
test('a merge of main commits cleanly when an attached companion changes a path of another lane [C7]', () => {
  const { box, builder } = fixture({ fixer: true });
  box.env.PB_CHECKED_OUT = join(box.dir, 'checked.txt');
  box.git(builder, 'rm', '-q', 'web/shim.js');
  const first = box.tryGit(builder, 'commit', '-q', '-m', 'refactor(web): delete the shim [G1]');
  assert.equal(first.status, 0, `${first.stdout}${first.stderr}`);
  write(box.repo, { 'web/other.txt': 'main moved\n' });
  box.git(box.repo, 'add', 'web/other.txt');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: advance main');
  const merged = box.tryGit(builder, 'merge', '--no-edit', 'main');
  assert.equal(merged.status, 0, `${merged.stdout}${merged.stderr}${merged.failure ?? ''}`);
  assert.equal(box.git(builder, 'show', 'HEAD:api/serve.js').trim(), SHIM_IMPORT.trim(), 'the companion is never committed');
});

test('control: a builder who stages a file of another lane is still refused [C7]', () => {
  const { box, builder } = fixture({ fixer: true });
  box.env.PB_CHECKED_OUT = join(box.dir, 'checked.txt');
  box.git(builder, 'rm', '-q', 'web/shim.js');
  write(builder, { 'api/own.js': 'export default 2;\n' });
  box.git(builder, 'add', 'api/own.js');
  const refused = box.tryGit(builder, 'commit', '-q', '-m', 'refactor(web): delete the shim [G1]');
  assert.notEqual(refused.status, 0, `${refused.stdout}${refused.stderr}${box.git(builder, 'log', '-1', '--format=%s')}`);
  assert.match(`${refused.stdout}${refused.stderr}`, /outside the web lane: .*api/u);
});

/**
 * A core builder whose item has an attached companion touching the coordinator-owned .githooks directory: the real
 * CLI behind the composed entry runs the lane rule, which must see only the builder's staged paths.
 */
function hooksFixture() {
  const box = helpers.project('true');
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  config.lanes.core = { owns: ['core/'], specs: ['G1'] };
  // Seat routes come from the board's model table since b95e1aa538.
  config.modelTiers = [{ contains: box.env.PULLBOARD_MODEL, route: 'strong' }];
  write(box.repo, {
    'pullboard.json': JSON.stringify(config, null, 2),
    'core/value.txt': 'one\n',
    '.githooks/pre-commit': '#!/bin/sh\nexit 0\n',
    'apps/cli/pullboard.js': `const { runComposedHook } = await import(${JSON.stringify(HOOK_MODULE)});\n`
      + 'const composed = await runComposedHook(process.argv[1], process.argv.slice(2), { cwd: process.cwd(), env: process.env });\n'
      + 'if (composed !== null) process.exit(composed);\n'
      + `await import(${JSON.stringify(REAL_CLI)});\n`,
    '.selfhooks/pre-commit': `#!/bin/sh\nroot=$(git rev-parse --show-toplevel)\nexec "${process.execPath}" "$root/apps/cli/pullboard.js" hook pre-commit\n`,
  });
  chmodSync(join(box.repo, '.selfhooks/pre-commit'), 0o755);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: seed a core lane and a hooks file');
  const core = join(box.dir, 'core-1');
  box.git(box.repo, 'worktree', 'add', '-q', core, '-b', 'core/one');
  assert.match(fixtureJoin(box.run, core, 'core').out, /joined as core-/u);
  // The coordinator owns .githooks, so its seat authors the companion.
  const author = run(box, box.repo, 'whoami').id;
  const item = run(box, box.repo, 'add', 'core', 'Edit the core value', '--specs', 'G1').item.item_id;
  box.git(core, 'merge', '-q', '--ff-only', 'main');
  const claimed = run(box, core, 'claim', String(item));
  const builder = claimed.itemFolder ?? core;
  const source = box.git(builder, 'rev-parse', 'HEAD').trim();
  const patch = join(box.dir, 'hooks.patch');
  writeFileSync(patch, 'diff --git a/.githooks/pre-commit b/.githooks/pre-commit\n--- a/.githooks/pre-commit\n+++ b/.githooks/pre-commit\n@@ -1,2 +1,2 @@\n'
    + ' #!/bin/sh\n-exit 0\n+exit 0 # companion\n');
  run(box, box.repo, 'patch', 'attach', String(item), patch, '--key', 'hooks', '--author', author, '--source', source);
  box.git(box.repo, 'config', 'core.hooksPath', '.selfhooks');
  return { box, builder };
}

test('a staged core change commits cleanly beside an attached .githooks companion [C7]', () => {
  const { box, builder } = hooksFixture();
  writeFileSync(join(builder, 'core/value.txt'), 'two\n');
  box.git(builder, 'add', 'core/value.txt');
  const committed = box.tryGit(builder, 'commit', '-q', '-m', 'feat(core): edit the value [G1]');
  assert.equal(committed.status, 0, `${committed.stdout}${committed.stderr}${committed.failure ?? ''}`);
  assert.equal(box.git(builder, 'show', 'HEAD:core/value.txt').trim(), 'two', 'the core change is committed');
  assert.equal(box.git(builder, 'show', 'HEAD:.githooks/pre-commit').trim(), '#!/bin/sh\nexit 0', 'the .githooks companion is checked, never committed');
});

test('control: a builder who stages a file of another lane is still refused beside the .githooks companion [C7]', () => {
  const { box, builder } = hooksFixture();
  writeFileSync(join(builder, 'core/value.txt'), 'two\n');
  write(builder, { 'api/own.js': 'export default 2;\n' });
  box.git(builder, 'add', 'core/value.txt', 'api/own.js');
  const refused = box.tryGit(builder, 'commit', '-q', '-m', 'feat(core): edit the value [G1]');
  assert.notEqual(refused.status, 0, `${refused.stdout}${refused.stderr}`);
  assert.match(`${refused.stdout}${refused.stderr}`, /outside the core lane: .*api/u);
});

test('a pre-commit with no companion patch runs the checkout itself and writes no tree copy [C7]', () => {
  const { box, builder } = fixture({ companion: false });
  const probe = join(box.dir, 'probe.json');
  box.env.PB_PROBE = probe;
  write(builder, { 'web/real.js': 'export const value = 2;\n' });
  box.git(builder, 'add', 'web/real.js');
  const committed = box.tryGit(builder, 'commit', '-q', '-m', 'feat(web): change the value [G1]');
  assert.equal(committed.status, 0, `${committed.stdout}${committed.stderr}${committed.failure ?? ''}`);
  assert.equal(realpathSync(JSON.parse(readFileSync(probe, 'utf8')).dir), realpathSync(join(builder, 'apps/cli')), 'the entry ran in place');
});

test('control: an unstaged edit to a code file makes the hook run the staged bytes from a copy [C7]', () => {
  const { box, builder } = fixture({ companion: false });
  const probe = join(box.dir, 'probe.json');
  box.env.PB_PROBE = probe;
  write(builder, { 'web/real.js': 'export const value = 2;\n' });
  box.git(builder, 'add', 'web/real.js');
  write(builder, { 'web/real.js': 'export const value = 3;\n' });
  const committed = box.tryGit(builder, 'commit', '-q', '-m', 'feat(web): change the value [G1]');
  assert.equal(committed.status, 0, `${committed.stdout}${committed.stderr}${committed.failure ?? ''}`);
  assert.match(JSON.parse(readFileSync(probe, 'utf8')).dir, /pullboard-hook-/u, 'the entry ran from a copy');
});

test('with a companion patch the composed tree holds the code and leaves tests and journeys out [C7]', () => {
  const { box, builder } = fixture();
  const probe = join(box.dir, 'probe.json');
  box.env.PB_PROBE = probe;
  box.git(builder, 'rm', '-q', 'web/shim.js');
  const committed = box.tryGit(builder, 'commit', '-q', '-m', 'refactor(web): delete the shim [G1]');
  assert.equal(committed.status, 0, `${committed.stdout}${committed.stderr}${committed.failure ?? ''}`);
  const seen = JSON.parse(readFileSync(probe, 'utf8'));
  assert.match(seen.dir, /pullboard-hook-/u, 'the entry ran from the composed copy');
  assert.equal(seen.real, true, 'the code the check loads is written');
  assert.equal(seen.unread, false, 'tests are not written');
  assert.equal(seen.data, true, 'a data folder named tests is written: the CLI reads its files when it loads');
});
