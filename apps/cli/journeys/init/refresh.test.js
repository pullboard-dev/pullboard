/** Real isolated Git refresh: guards must pass before main advances [A5,C7,B3]. */
import assert from 'node:assert/strict';
import {
  spawn,
  spawnSync,
} from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

function fixture(t, failing, slow = false) {
  const root = mkdtempSync(join(tmpdir(), 'guarded-docs-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const temporary = mkdtempSync(join(tmpdir(), 'guarded-docs-long-location-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const longTemp = join(temporary, ...Array(5).fill('long-runner-location-'.repeat(3)));
  mkdirSync(longTemp, { recursive: true });
  const put = (file, value) => { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), value); };
  const env = { ...process.env, TMPDIR: longTemp, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const command = (program, args) => spawnSync(program, args, { cwd: root, encoding: 'utf8', env });
  const git = (...args) => { const result = command('git', args); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  git('init', '-q', '-b', 'main');
  put('package.json', '{"type":"module"}\n');
  put('docs/tools/guarded-docs-refresh.js', readFileSync(new URL('../../../../docs/tools/guarded-docs-refresh.js', import.meta.url)));
  put('packages/merge/light.js', "export const GENERATED_DOC_PATHS = ['docs/formats.md'];\n");
  put('packages/drive/light.js', "export const DEFAULT_FILE_WALL_MS = 300000;\n");
  put('docs/formats.md', 'old\n');
  put('docs/tools/update-docs.js', `import {writeFileSync} from 'node:fs'; if (process.argv.includes('--check')) { process.exitCode = ${failing === 'docs' ? 1 : 0}; } else { writeFileSync('docs/formats.md', 'generated\\n'); }\n`);
  put('docs/formats.test.js', `import { test } from 'node:test'; import assert from 'node:assert/strict'; test('named format guard', async () => { ${slow ? 'await new Promise(resolve => setTimeout(resolve, 121000));' : ''} assert.equal(${failing === 'formats' ? 'false' : 'true'}, true, 'format fixture failure'); });\n`);
  put('apps/cli/pullboard.js', `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(join(root, '..', `${root.split('/').at(-1)}-shout`))}, process.argv.join(' '));\n`);
  git('add', '-A'); git('commit', '-q', '-m', 'fixture');
  const before = git('rev-parse', 'HEAD');
  const shout = join(root, '..', `${root.split('/').at(-1)}-shout`);
  t.after(() => rmSync(shout, { force: true }));
  return { root, before, git, command, shout, env };
}
for (const failure of ['formats', 'docs', null]) test(`generated docs ${failure ? `refuse a ${failure} guard failure` : 'land only after both guards pass'} [A5,C7,B3]`, t => {
  const box = fixture(t, failure);
  const result = box.command(process.execPath, ['docs/tools/guarded-docs-refresh.js']);
  if (failure) {
    assert.equal(result.status, failure === 'formats' ? 3 : 4, result.stdout + result.stderr);
    assert.equal(box.git('rev-parse', 'HEAD'), box.before);
    assert.match(readFileSync(box.shout, 'utf8'), /shout all/u, 'coordinator-origin failures broadcast without self-shout');
    assert.match(readFileSync(box.shout, 'utf8'), new RegExp(`${failure} guard`, 'u'));
    if (failure === 'formats') {
      assert.ok(result.stdout.includes('long-runner-location-'.repeat(3)), 'the real TAP location exceeds the shout budget');
      assert.match(readFileSync(box.shout, 'utf8'), /named format guard/u);
      assert.match(readFileSync(box.shout, 'utf8'), /format fixture failure/u);
    }
    assert.equal(readFileSync(join(box.root, 'docs/formats.md'), 'utf8'), 'old\n');
  } else {
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.notEqual(box.git('rev-parse', 'HEAD'), box.before);
    assert.equal(readFileSync(join(box.root, 'docs/formats.md'), 'utf8'), 'generated\n');
  }
  assert.equal(box.git('status', '--porcelain'), '');
  assert.equal(box.git('worktree', 'list', '--porcelain').split('worktree ').length - 1, 1);
});

test('clause 1: a formats guard that takes over two minutes can pass [A5,C7,B3]', async t => {
  const box = fixture(t, null, true);
  // The file's own process stays audible while the slow guard runs, so the idle watchdog sees a live test.
  const child = spawn(process.execPath, ['docs/tools/guarded-docs-refresh.js'], { cwd: box.root, env: box.env });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise(resolve => child.on('close', status => resolve({ status, stdout, stderr })));
  let result;
  while (!(result = await Promise.race([closed, new Promise(resolve => setTimeout(() => resolve(null), 15000))]))) {
    process.stderr.write('waiting for the slow formats guard\n');
  }
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.notEqual(box.git('rev-parse', 'HEAD'), box.before);
});
